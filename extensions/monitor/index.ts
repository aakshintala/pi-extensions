// The monitor tool (spec #30, ticket #50), with Claude Code's rules: each batch of
// lines a watch command prints on stdout becomes one notice to the agent, cut and
// rate-limited; a flood, the deadline or 5 GB of output stops it as failed. Stdout goes to a log the
// FleetView row shows, stderr to a separate log. Every timer runs on the seam below.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmdirSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleet } from "../../shared/fleet/index.ts";
import { groupOf, pastOutputCap, signalGroup, tooManyJobs, track, type Group } from "../../shared/process-groups/index.ts";
import { oneLine, unfinished } from "../../shared/text/index.ts";
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";

const LINE_CHARS = 500;
const NOTICE_CHARS = 3000;
/** A notice shows at most this much of the description, so the drop count and the lines survive the notice cut. */
const NAME_CHARS = 100;
/** An unended line longer than this is sanitised and cut early, so it cannot grow without bound. */
const PARTIAL_MAX = 4 * LINE_CHARS;
/** Notices a monitor may send at once; one comes back every REFILL_MS. */
const BUDGET = 10;
const REFILL_MS = 2000;
/**
 * A flood window opens at a drop and stays open while drops keep coming, each within
 * REFILL_MS of the last; one open this long stops the monitor as `flooded`.
 */
const FLOOD_MS = 30_000;
const DEFAULT_S = 300;
const MAX_S = 1800;
const MAX_HEADLESS_S = 600;
/** Grace between SIGTERM and SIGKILL to the monitor's process group. */
const KILL_MS = 800;
/** How often a killed group is checked until its zombies are reaped. */
const ZOMBIE_MS = 10;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
/** Refill, flood, deadline and kill timers. Tests replace them through this symbol. */
const timers = (): Timers => (globalThis as any)[Symbol.for("pi-rig.monitor.timers")] ?? globalThis;
// Referenced: a headless Pi must not exit before a pending SIGKILL fires.
const delay = (ms: number) => new Promise<void>((r) => timers().setTimeout(r, ms));

/** The first `n` code points of `s`. */
const cut = (s: string, n: number) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

type Reason = "flooded" | "timeout" | "output" | "stopped" | "shutdown";
type Monitor = Group & {
  id: string;
  owner: string;
  description: string;
  log: string;
  errors: string;
  seconds: number;
  out: number;
  code?: number;
  reason?: Reason;
  /** Set once the group is being ended; resolves when it is empty and the monitor has settled. */
  killed?: Promise<void>;
  tokens: number;
  dropped: number;
  partial: string;
  refill?: unknown;
  flood?: unknown;
  /** Closes the flood window when REFILL_MS pass without a drop. */
  gap?: unknown;
  deadline?: unknown;
  /** Resolves once stdout has closed and the end notice is sent. */
  done: Promise<void>;
};

/** The last line in the last 4 KiB of a log; empty if it cannot be read. */
function lastLine(file: string) {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(4096, size);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8").trimEnd().split("\n").at(-1) ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export default function (pi: ExtensionAPI) {
  const monitors = new Map<string, Monitor>();
  let dir: string | undefined; // this session's log directory, left for the OS to clean

  const name = (m: Monitor) => `Monitor ${m.id} (${cut(oneLine(m.description), NAME_CHARS)})`;

  /** One notice for lines that arrived together, if the budget has one. */
  function deliver(m: Monitor, lines: string[]) {
    const t = timers();
    if (m.tokens === 0) {
      m.dropped++;
      m.flood ??= t.setTimeout(() => void stop(m, "flooded"), FLOOD_MS);
      if (m.gap !== undefined) t.clearTimeout(m.gap as any);
      m.gap = t.setTimeout(() => {
        t.clearTimeout(m.flood as any);
        m.flood = m.gap = undefined;
      }, REFILL_MS);
      return;
    }
    m.tokens--;
    m.refill ??= t.setTimeout(function refill() {
      m.tokens++;
      m.refill = m.tokens < BUDGET ? t.setTimeout(refill, REFILL_MS) : undefined;
    }, REFILL_MS);
    const dropped = m.dropped;
    m.dropped = 0;
    const head = `${name(m)}:${dropped ? ` (${dropped} earlier notices suppressed by the rate limit)` : ""}`;
    const text = [head, ...lines.map((l) => cut(oneLine(l), LINE_CHARS))].join("\n");
    fleet().notify(m.id, cut(text, NOTICE_CHARS));
  }

  function start(p: { command: string; description: string }, seconds: number, c: ExtensionContext): Monitor {
    const full = tooManyJobs();
    if (full) throw new Error(full);
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
    const m: Monitor = { id, owner: c.sessionManager.getSessionId(), description: p.description, log, errors, seconds, child, pgid: child.pid, record: join(dir, `${id}.pid`), counted: true, out, tokens: BUDGET, dropped: 0, partial: "", done: closed.then(() => settle(m)) };
    track(m);
    child.stdout?.setEncoding("utf8"); // whole code points, even across chunks
    child.stdout?.on("data", (chunk: string) => {
      writeSync(m.out, chunk);
      if (!m.reason && pastOutputCap(log)) void stop(m, "output");
      const lines = (m.partial + chunk).split("\n");
      m.partial = lines.pop()!;
      if (m.partial.length > PARTIAL_MAX) {
        // Keep the line's start, clean and cut, and hold back a sequence the chunk cut off.
        const i = unfinished(m.partial);
        m.partial = cut(oneLine(m.partial.slice(0, i)), LINE_CHARS) + m.partial.slice(i, i + PARTIAL_MAX);
      }
      if (lines.length && !m.reason) deliver(m, lines);
    });
    child.once("exit", (code, signal) => {
      m.code = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0);
      void kill(m); // ends what the shell left in its group, and a pipe held open past it
    });
    child.once("error", () => ((m.code = 127), void kill(m)));
    m.deadline = timers().setTimeout(() => void stop(m, "timeout"), seconds * 1000);
    monitors.set(id, m);
    fleet().register({ id, owner: m.owner, kind: "monitor", label: oneLine(p.description), activity: () => lastLine(log), view: { log }, stop: () => stop(m, "stopped") });
    return m;
  }

  /**
   * SIGTERM to the group; if any of it is alive after KILL_MS, SIGKILL until it is empty,
   * then the pipe closed. `groupOf` forgets the group, and its crash record, once it is empty.
   */
  function kill(m: Monitor) {
    return (m.killed ??= (async () => {
      signalGroup(groupOf(m), "SIGTERM");
      const grace = delay(KILL_MS);
      await Promise.race([m.done, grace]);
      if (groupOf(m)) {
        await grace;
        signalGroup(groupOf(m), "SIGKILL");
        // Killed processes linger briefly as zombies until init reaps them.
        for (let i = 0; i < 100 && groupOf(m); i++) await delay(ZOMBIE_MS);
      }
      m.child.stdout?.destroy(); // a process outside the group may still hold it
      await m.done;
      monitors.delete(m.id);
    })());
  }

  /** Clears the monitor's timers: nothing may fire once it is ending. */
  function clear(m: Monitor) {
    const t = timers();
    for (const h of [m.refill, m.flood, m.gap, m.deadline]) if (h !== undefined) t.clearTimeout(h as any);
    m.refill = m.flood = m.gap = m.deadline = undefined;
  }

  function stop(m: Monitor, reason: Reason) {
    m.reason ??= reason;
    clear(m);
    return kill(m);
  }

  function settle(m: Monitor) {
    if (m.partial && !m.reason) deliver(m, [m.partial]); // a last line with no newline
    clear(m);
    closeSync(m.out);
    const logs = `Log: ${m.log}. Errors: ${m.errors}`;
    const end = {
      flooded: ["failed", "flooded", `${name(m)} failed [flooded]: it printed faster than the rate limit for ${FLOOD_MS / 1000}s. Tighten the command's filter so it prints fewer lines. ${logs}`],
      timeout: ["failed", "timeout", `${name(m)} failed [timeout]: it reached its ${m.seconds}s deadline. ${logs}`],
      output: ["failed", "output", `${name(m)} failed [output]: its output passed 5 GB. Tighten the command's filter. ${logs}`],
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
        timeout: { type: "number", description: `Seconds, default ${DEFAULT_S}, max ${MAX_S} (${MAX_HEADLESS_S} without UI)` },
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
      summary: { verb: "started", one: "monitor" },
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
