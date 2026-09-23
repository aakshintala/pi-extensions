// The monitor tool (spec #30, ticket #50), with Claude Code's rules: each batch of
// lines a watch command prints on stdout becomes one notice to the agent, cut and
// rate-limited; a flood or the deadline stops it as failed. Stdout goes to a log the
// FleetView row shows, stderr to a separate log. Every timer runs on the seam below.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmdirSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleet } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";

const LINE_CHARS = 500;
const NOTICE_CHARS = 3000;
/** Notices a monitor may send at once; one comes back every REFILL_MS. */
const BUDGET = 10;
const REFILL_MS = 2000;
/** Suppression lasting this long stops the monitor as `flooded`. */
const FLOOD_MS = 30_000;
const DEFAULT_S = 300;
const MAX_S = 1800;
const MAX_HEADLESS_S = 600;
/** Grace between SIGTERM and SIGKILL to the monitor's process group. */
const KILL_MS = 800;
const MAX_TIMER_MS = 2 ** 31 - 1;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
/** Refill, flood, deadline and kill timers. Tests replace them through this symbol. */
const timers = (): Timers => (globalThis as any)[Symbol.for("pi-rig.monitor.timers")] ?? globalThis;

type Reason = "flooded" | "timeout" | "stopped" | "shutdown";
type Monitor = {
  id: string;
  owner: string;
  description: string;
  log: string;
  errors: string;
  seconds: number;
  child: ChildProcess;
  out: number;
  code?: number;
  reason?: Reason;
  killing?: boolean;
  tokens: number;
  dropped: number;
  partial: string;
  refill?: unknown;
  flood?: unknown;
  deadline?: unknown;
  done: Promise<void>;
};

const signalGroup = (pgid: number | undefined, signal: NodeJS.Signals) => {
  try {
    if (pgid) process.kill(-pgid, signal);
  } catch {}
};

// ponytail: same exit-handler idea as extensions/jobs, kept local because jobs exports nothing.
const GROUPS = Symbol.for("pi-rig.monitor.groups");
/** Monitor groups of this process: a crash skips `session_shutdown`, so one `exit` handler SIGKILLs them. */
function groups(): Set<number> {
  const g = globalThis as { [GROUPS]?: Set<number> };
  if (!g[GROUPS]) {
    const live = (g[GROUPS] = new Set<number>());
    process.on("exit", () => {
      for (const pgid of live) signalGroup(pgid, "SIGKILL");
    });
  }
  return g[GROUPS];
}

const lastLine = (file: string) => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").at(-1) ?? "";
  } catch {
    return "";
  }
};

export default function (pi: ExtensionAPI) {
  const monitors = new Map<string, Monitor>();
  let dir: string | undefined; // this session's log directory, left for the OS to clean

  const name = (m: Monitor) => `Monitor ${m.id} (${oneLine(m.description)})`;

  /** One notice for lines that arrived together, if the budget has one. */
  function deliver(m: Monitor, lines: string[]) {
    const t = timers();
    if (m.tokens === 0) {
      m.dropped++;
      m.flood ??= t.setTimeout(() => void stop(m, "flooded"), FLOOD_MS);
      return;
    }
    m.tokens--;
    m.refill ??= t.setTimeout(function refill() {
      m.tokens++;
      m.refill = m.tokens < BUDGET ? t.setTimeout(refill, REFILL_MS) : undefined;
    }, REFILL_MS);
    const dropped = m.dropped;
    m.dropped = 0;
    if (!dropped && m.flood !== undefined) {
      t.clearTimeout(m.flood as any);
      m.flood = undefined;
    }
    const head = `${name(m)}:${dropped ? ` (${dropped} earlier notices suppressed by the rate limit)` : ""}`;
    const text = [head, ...lines.map((l) => oneLine(l).slice(0, LINE_CHARS))].join("\n");
    fleet().notify(m.id, text.slice(0, NOTICE_CHARS));
  }

  function start(p: { command: string; description: string }, seconds: number, c: ExtensionContext): Monitor {
    dir ??= mkdtempSync(join(tmpdir(), "pi-monitor-"));
    const id = randomUUID().slice(0, 8);
    const log = join(dir, `${id}.log`);
    const errors = join(dir, `${id}.err.log`);
    const out = openSync(log, "a", 0o600);
    const err = openSync(errors, "a", 0o600);
    const shell = getShellConfig();
    const stdin = shell.commandTransport === "stdin";
    let child: ChildProcess;
    try {
      child = spawn(shell.shell, stdin ? shell.args : [...shell.args, p.command], { cwd: c.cwd, detached: true, stdio: [stdin ? "pipe" : "ignore", "pipe", err] });
    } catch (e) {
      closeSync(out);
      throw e;
    } finally {
      closeSync(err);
    }
    if (stdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(p.command);
    }
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const m: Monitor = { id, owner: c.sessionManager.getSessionId(), description: p.description, log, errors, seconds, child, out, tokens: BUDGET, dropped: 0, partial: "", done: closed.then(() => settle(m)) };
    if (child.pid) groups().add(child.pid);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      writeSync(m.out, chunk);
      const lines = (m.partial + chunk).split("\n");
      m.partial = lines.pop()!.slice(0, LINE_CHARS); // a line past the cut keeps only its start
      if (lines.length && !m.reason) deliver(m, lines);
    });
    child.once("exit", (code, signal) => {
      m.code = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0);
      void kill(m); // ends what the shell left in its group, and a pipe held open past it
    });
    child.once("error", () => ((m.code = 127), void kill(m)));
    m.deadline = timers().setTimeout(() => void stop(m, "timeout"), Math.min(seconds * 1000, MAX_TIMER_MS));
    monitors.set(id, m);
    fleet().register({ id, owner: m.owner, kind: "monitor", label: oneLine(p.description), activity: () => lastLine(log), view: { log }, stop: () => stop(m, "stopped") });
    return m;
  }

  /** SIGTERM to the group; SIGKILL and the pipe closed after KILL_MS unless it closed first. */
  function kill(m: Monitor) {
    if (m.killing) return m.done;
    m.killing = true;
    signalGroup(m.child.pid, "SIGTERM");
    const t = timers();
    const timer = t.setTimeout(() => {
      signalGroup(m.child.pid, "SIGKILL");
      m.child.stdout?.destroy();
    }, KILL_MS);
    void m.done.then(() => t.clearTimeout(timer));
    return m.done;
  }

  function stop(m: Monitor, reason: Reason) {
    m.reason ??= reason;
    return kill(m);
  }

  function settle(m: Monitor) {
    if (m.partial && !m.reason) deliver(m, [m.partial]); // a last line with no newline
    const t = timers();
    for (const h of [m.refill, m.flood, m.deadline]) if (h !== undefined) t.clearTimeout(h as any);
    closeSync(m.out);
    if (m.child.pid) groups().delete(m.child.pid);
    monitors.delete(m.id);
    const logs = `Log: ${m.log}. Errors: ${m.errors}`;
    const end = {
      flooded: ["failed", "flooded", `${name(m)} failed [flooded]: its notices were suppressed for ${FLOOD_MS / 1000}s. Tighten the command's filter so it prints fewer lines. ${logs}`],
      timeout: ["failed", "timeout", `${name(m)} failed [timeout]: it reached its ${m.seconds}s deadline. ${logs}`],
      stopped: ["stopped", "stopped", `${name(m)} stopped. ${logs}`],
      shutdown: ["stopped", "stopped", null],
    } as const;
    const [status, result, notice] = m.reason
      ? end[m.reason]
      : ([m.code === 0 ? "completed" : "failed", `exit ${m.code}`, `${name(m)} ended: its command exited with code ${m.code}. ${logs}`] as const);
    fleet().finish(m.id, status, result, notice);
  }

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Run a watch command in the background. Each batch of stdout lines it prints reaches you as a notice while you work, so filter it to the events you need " +
      "(e.g. `tail -f app.log | grep --line-buffered ERROR`). Lines are cut at 500 characters. A monitor that prints too often is rate-limited, then stopped. " +
      "It ends when the command exits or after timeout seconds. Stderr goes to a separate log.",
    parameters: {
      type: "object",
      required: ["command", "description"],
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Watch command; each stdout line is an event" },
        description: { type: "string", description: "Short name shown on its notices" },
        timeout: { type: "number", description: `Seconds, default ${DEFAULT_S}, max ${MAX_S}` },
      },
    },
    async execute(_id: string, p: { command: string; description: string; timeout?: number }, _s: unknown, _u: unknown, c: ExtensionContext) {
      if (p.timeout !== undefined && !(p.timeout > 0)) throw new Error("timeout must be a positive number of seconds");
      const seconds = Math.min(p.timeout ?? DEFAULT_S, c.hasUI ? MAX_S : MAX_HEADLESS_S);
      const m = start(p, seconds, c);
      const text = `Started monitor ${m.id}; its output lines arrive as notices until it ends or after ${seconds}s. Log: ${m.log}. Errors: ${m.errors}`;
      return { content: [{ type: "text" as const, text }], details: { id: m.id, log: m.log, errors: m.errors } };
    },
    ...toolRenderers({
      title: "Monitor",
      arg: (a: any) => oneLine(a?.description ?? ""),
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);

  // Monitors belong to this session: shutdown, reload and session switch stop every one, without a notice.
  pi.on("session_shutdown", async () => {
    await Promise.all([...monitors.values()].map((m) => stop(m, "shutdown")));
    try {
      if (dir) rmdirSync(dir); // only when no monitor left a log
    } catch {}
  });
}
