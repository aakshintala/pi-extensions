// Background bash and the jobs tool (spec #30, ticket #48). `bash` replaces Pi's
// built-in: it runs Pi's own bash tool over our process backend, so output
// formatting, truncation and PI_* variables stay Pi's. Each command writes to a
// log file; one still running after `autoBackgroundSeconds`, or started with
// `run_in_background`, becomes a job: a fleet `shell` row whose end is one notice.
// Guards and crash clean-up are #49 (guards.ts), monitor is #50. A foreground
// command is a fleet foreground: Ctrl+B and a queued steer background it (#51).
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { createBashToolDefinition, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { duration, fleet, type FinalStatus } from "../../shared/fleet/index.ts";
import { rigSettings } from "../../shared/settings/index.ts";
import { keepSgr, oneLine } from "../../shared/text/index.ts";
import { resultText, showHint, toolRenderers } from "../../shared/tool-display/index.ts";
import { ctrlBFree } from "../../shared/tui/index.ts";
import { logDir, MAX_GROUPS, MAX_OUTPUT, MAX_OUTPUT_BYTES, reap, setGroupLimit, spawnGroup, timers, tooManyJobs } from "../../shared/process-groups/index.ts";
import { blockingSleep, PROMPT } from "./guards.ts";

/** A failure notice carries this many last lines, cut to this many characters. */
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
/** How often a foreground command's log is read for live output. */
const POLL_MS = 100;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How often a job's log size and group are checked. */
const TICK_MS = 1000;
/** Ticks of unchanged output before a prompt-shaped last line warns the agent. */
const QUIET_TICKS = 10;
/** Finished jobs `jobs list` keeps; older ones are forgotten when a new one starts. */
const KEEP_FINISHED = 20;

type Job = {
  id: string;
  g: ReturnType<typeof spawnGroup>;
  owner: string;
  command: string;
  log: string;
  startedAt: number;
  /** Became a job: it has a fleet row and gets a notice. */
  bg: boolean;
  status?: FinalStatus;
  code?: number;
  endedAt?: number;
  stopped?: boolean;
  timedOut?: number;
  /** Its group is being killed: leftover processes are not reported. */
  killing?: boolean;
  /** Why the rig stopped it. */
  reason?: string;
  /** The prompt warning was sent. */
  warned?: boolean;
  /** Tool calls (wait, stop) that will return the final state: the notice is then left out. */
  waiters: number;
  /** Resolves once `status` is set. */
  done: Promise<void>;
  /** Set while in the foreground: settles its bash call. */
  fg?: (code: number) => void;
  /** The pending check of its log and group. */
  tick?: unknown;
};

/** The last `bytes` of a file as text; empty if it cannot be read. */
function tailOf(file: string, bytes: number) {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The last TAIL_LINES lines of a log, cut to its last TAIL_CHARS characters. */
function failureTail(log: string) {
  const text = tailOf(log, TAIL_CHARS * 4).replace(/\n$/, "").split("\n").slice(-TAIL_LINES).join("\n");
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

const lastLine = (log: string) => tailOf(log, 4096).trimEnd().split("\n").at(-1) ?? "";
/** The unfinished line the output ends on: where a prompt waits. Empty after a newline. */
const openLine = (log: string) => tailOf(log, 4096).split("\n").at(-1) ?? "";

/** Output as Pi's bash renderer shows it: no terminal sequences, no control characters but tab and newline. */
const clean = (s: string) =>
  keepSgr(s)
    .replace(/\x1b\[[0-9;:]*m/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export default function (pi: ExtensionAPI) {
  const section = rigSettings(getAgentDir()).declare("jobs", [
    { key: "autoBackgroundSeconds", type: "integer", min: 1, max: 3600, default: 30, description: "Seconds before a running bash command moves to the background" },
    { key: "maxJobs", type: "integer", min: 1, max: 64, default: MAX_GROUPS, description: "Most background jobs and monitors running at once" },
  ]);
  setGroupLimit(section.get("maxJobs") as number);
  const autoSeconds = () => section.get("autoBackgroundSeconds") as number;

  const jobs = new Map<string, Job>();
  const dir = logDir("jobs");
  let closing = false;

  const now = () => fleet().now();
  /** A finished job whose shell left processes behind in its group. */
  const lingers = (j: Job) => !!j.status && j.g.alive();
  const state = (j: Job) =>
    `Job ${j.id} ${j.status ?? "running"}${j.code === undefined ? "" : ` (exit ${j.code})`}${j.timedOut ? `, timed out after ${j.timedOut}s` : ""} after ${duration((j.endedAt ?? now()) - j.startedAt)}` +
    `${j.reason ? ` because ${j.reason}` : ""}. Log: ${j.log}` +
    (lingers(j) && !j.killing ? "\nIts shell exited, but processes it started are still running; stop ends them." : "");

  function start(command: string, cwd: string, env: NodeJS.ProcessEnv | undefined, owner: string): Job {
    const done = [...jobs.values()].filter((j) => j.status && !lingers(j));
    for (const j of done.slice(0, -KEEP_FINISHED)) jobs.delete(j.id);
    const id = randomUUID().slice(0, 8);
    const log = dir.path(`${id}.log`);
    // Output goes straight to the file and the job ends on `exit`, so a daemon holding it cannot hang the job.
    const g = spawnGroup({ command, cwd, env, dir, id, stdout: log, stderr: log, counted: false });
    const job: Job = { id, g, owner, command, log, startedAt: now(), bg: false, waiters: 0, done: undefined as any };
    job.done = g.exited.then((code) => settle(job, code));
    jobs.set(id, job);
    if (g.alive()) tick(job);
    return job;
  }

  /**
   * Every TICK_MS while the job's group lives: stops a job whose log passes MAX_OUTPUT_BYTES,
   * or what it left running once its shell exited, warns once when a background job's
   * output has stopped on a prompt-shaped line, and forgets the group once it is empty.
   * ponytail: the size is checked each tick, so a fast writer overshoots the cap by up to a tick's output.
   */
  function tick(j: Job, size = 0, quiet = 0) {
    const h: any = (j.tick = timers().setTimeout(() => {
      if (!j.g.alive()) return;
      let now = size;
      try {
        now = statSync(j.log).size;
      } catch {}
      if (now > MAX_OUTPUT_BYTES) {
        if (!j.status) j.reason = `its output passed ${MAX_OUTPUT}`;
        else if (!j.killing) fleet().notify(j.id, `Job ${j.id}: the processes its shell left running were stopped because its output passed ${MAX_OUTPUT}. Log: ${j.log}`);
        void stop(j);
        return;
      }
      quiet = now === size ? quiet + 1 : 0;
      const prompt = j.bg && !j.status && !j.warned && quiet >= QUIET_TICKS ? openLine(j.log) : "";
      if (PROMPT.test(prompt)) {
        j.warned = true;
        fleet().notify(j.id, `Job ${j.id} may be waiting for input: its output stopped at "${oneLine(prompt).trim().slice(-200)}". It gets no input; stop it and rerun it non-interactively.`);
      }
      tick(j, now, quiet);
    }, TICK_MS));
    h?.unref?.();
  }

  function settle(j: Job, code: number) {
    j.code = code;
    j.endedAt = now();
    j.status = j.stopped ? "stopped" : code === 0 && !j.timedOut ? "completed" : "failed";
    if (!lingers(j)) timers().clearTimeout(j.tick as any); // an empty group is forgotten; nothing left to check
    if (j.fg) return j.fg(code);
    const tail = j.status === "failed" ? failureTail(j.log) : "";
    const result = j.status === "stopped" ? "stopped" : `exit ${code}${j.timedOut ? `, timed out` : ""}${tail ? `\n${tail}` : ""}`;
    fleet().finish(j.id, j.status, result, j.waiters || closing ? null : `${state(j)}${tail ? `\nLast lines:\n${tail}` : ""}`);
  }

  function background(j: Job) {
    j.bg = true;
    j.g.count();
    j.fg = undefined;
    fleet().register({
      id: j.id,
      owner: j.owner,
      kind: "shell",
      label: oneLine(j.command),
      activity: () => lastLine(j.log),
      view: { log: j.log },
      stop: () => stop(j),
    });
  }

  /** Ends the job's process group, then its tick once the group is gone. */
  async function kill(j: Job) {
    j.killing = true;
    await j.g.kill();
    await j.done;
    if (!j.g.alive()) timers().clearTimeout(j.tick as any);
  }

  /** Stops a running job, or what a finished one left running in its group. */
  function stop(j: Job) {
    if (j.status && !lingers(j)) return j.done;
    if (!j.status) j.stopped = true;
    return kill(j);
  }

  /** Pi's bash backend: runs the command as a job, in the foreground until it ends or is backgrounded. */
  const operations = (owner: string, call: string, runInBackground: boolean, handle: { job?: Job; head?: string }) => ({
    exec: (command: string, cwd: string, o: { onData(data: Buffer): void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) =>
      new Promise<{ exitCode: number }>((resolve, reject) => {
        if (o.signal?.aborted) return reject(new Error("aborted"));
        const j = (handle.job = start(command, cwd, o.env, owner));
        const t = timers();
        let fd = -1;
        if (!runInBackground) {
          try {
            fd = openSync(j.log, "r");
          } catch (e) {
            void stop(j).then(() => jobs.delete(j.id));
            return reject(e);
          }
        }
        if (o.timeout !== undefined) {
          const limit = o.timeout;
          const timer = t.setTimeout(() => {
            if (j.status) return;
            j.timedOut = limit;
            void kill(j);
          }, Math.min(limit * 1000, MAX_TIMER_MS));
          void j.done.then(() => t.clearTimeout(timer));
        }
        if (runInBackground) {
          background(j);
          return reject(handle);
        }
        let offset = 0;
        const buf = Buffer.alloc(64 * 1024);
        const drain = () => {
          for (let n; (n = readSync(fd, buf, 0, buf.length, offset)) > 0; offset += n) o.onData(Buffer.from(buf.subarray(0, n)));
        };
        const poll = setInterval(drain, POLL_MS);
        const onAbort = () => void stop(j);
        o.signal?.addEventListener("abort", onAbort, { once: true });
        // The auto-background timer, Ctrl+B and a steer submitted meanwhile (through fleet) all move it here.
        // A child that has exited but not settled yet (its exit event before settle's microtask) finishes inline.
        const move = (head: string) => {
          if (j.status || !j.fg || j.g.child.exitCode !== null || j.g.child.signalCode !== null) return;
          handle.head = head;
          drain();
          end();
          background(j);
          reject(handle);
        };
        const seconds = autoSeconds();
        const auto = t.setTimeout(() => move(`Still running after ${seconds}s, so it moved to the background`), seconds * 1000);
        const unlist = fleet().foreground(owner, () => move("Moved to the background"));
        // Its call shows the hint while it can be backgrounded and Ctrl+B does that (#139).
        const unhint = showHint(owner, call, () => (ctrlBFree() ? "ctrl+b to run in background" : undefined));
        const end = () => {
          unlist();
          unhint();
          clearInterval(poll);
          t.clearTimeout(auto);
          o.signal?.removeEventListener("abort", onAbort);
          closeSync(fd);
        };
        j.fg = (code) => {
          drain();
          end();
          if (!lingers(j)) jobs.delete(j.id); // else kept, so shutdown ends what it left running
          rmSync(j.log, { force: true }); // ran in the foreground: its output is in the result
          if (o.signal?.aborted) reject(new Error("aborted"));
          else if (j.reason) reject(new Error(`Command stopped because ${j.reason}.`));
          else if (j.timedOut) reject(new Error(`timeout:${j.timedOut}`));
          else resolve({ exitCode: code });
        };
      }),
  });

  const cwd = process.cwd();
  const base = createBashToolDefinition(cwd);
  const reply = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

  const bashTool = () => ({
    ...base,
    description:
      `Run a bash command. Returns its output (the last 2000 lines or 50KB). A command still running after ${autoSeconds()}s moves to the background: ` +
      "you get its job ID and log path, and a notice when it ends. Set run_in_background for servers and long builds. Read logs with read.",
    promptGuidelines: undefined,
    parameters: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Bash command" },
        timeout: { type: "number", description: "Seconds, then killed" },
        run_in_background: { type: "boolean", description: "Return the job ID at once" },
      },
    },
    async execute(toolCallId: string, p: { command: string; timeout?: number; run_in_background?: boolean }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (p.timeout !== undefined && !(p.timeout > 0)) throw new Error("timeout must be a positive number of seconds");
      if (!p.run_in_background && blockingSleep(p.command))
        throw new Error(
          "Blocked: a bare sleep only waits. To wait for a condition, poll in a loop (until <check>; do sleep 1; done). " +
            "To wait for a job, use jobs wait. For long work, set run_in_background; to react to output, use monitor.",
        );
      const full = p.run_in_background ? tooManyJobs() : undefined;
      if (full) throw new Error(full);
      const handle: { job?: Job; head?: string } = {};
      const def = createBashToolDefinition(ctx.cwd, { operations: operations(ctx.sessionManager.getSessionId(), toolCallId, !!p.run_in_background, handle) });
      try {
        return await def.execute(toolCallId, { command: p.command, timeout: p.timeout }, signal, onUpdate, ctx);
      } catch (e) {
        if (e !== handle) throw e;
        const j = handle.job!;
        const head = handle.head ? `${handle.head} as job ${j.id}.` : `Started job ${j.id}.`;
        return reply(`${head} Log: ${j.log}\nA notice arrives when it ends.`, { id: j.id, log: j.log });
      }
    },
    ...toolRenderers({
      title: "Bash",
      arg: (a: any) => oneLine(a?.command ?? ""),
      summary: { verb: "ran", one: "shell command" },
      result: (r: any, _a, _e, theme) => {
        const [first = "", ...rest] = clean(resultText(r)).replace(/\n$/, "").split("\n");
        return { summary: first || "(no output)", body: rest.map((l) => theme.fg("toolOutput", l)) };
      },
    }),
  });
  pi.registerTool(bashTool() as any);

  /** This session's job, or an error naming the id. */
  const find = (id: string | undefined, c: ExtensionContext, action: string) => {
    if (!id) throw new Error(`${action} needs an id.`);
    const j = jobs.get(id);
    if (!j?.bg || j.owner !== c.sessionManager.getSessionId()) throw new Error(`No job ${id} of yours. Use an id from jobs list.`);
    return j;
  };
  const withTail = (j: Job) => {
    const tail = failureTail(j.log);
    return `${state(j)}${tail ? `\nLast lines:\n${tail}` : ""}`;
  };

  pi.registerTool({
    name: "jobs",
    label: "Jobs",
    description:
      "List, wait on or stop your background jobs. wait returns when the job ends or after timeout seconds (default 30, 10-3600), " +
      "with its status and last lines; the job keeps running if the wait ends first. stop kills the job and its children.",
    parameters: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "wait", "stop"] },
        id: { type: "string", description: "For wait and stop" },
        timeout: { type: "number", description: "wait only" },
      },
    },
    async execute(_id: string, p: { action: "list" | "wait" | "stop"; id?: string; timeout?: number }, signal: AbortSignal | undefined, _u: unknown, c: ExtensionContext) {
      if (p.action === "list") {
        const mine = [...jobs.values()].filter((j) => j.bg && j.owner === c.sessionManager.getSessionId());
        return reply(mine.length ? mine.map((j) => `${state(j)}\n  $ ${oneLine(j.command)}`).join("\n") : "No jobs.");
      }
      // A monitor is a fleet row of kind monitor; stop ends it through the row.
      const row = p.id && !jobs.has(p.id) ? fleet().get(p.id) : undefined;
      if (p.action === "stop" && row?.kind === "monitor" && row.owner === c.sessionManager.getSessionId()) {
        await row.stop();
        return reply(`Monitor ${row.id} ${fleet().get(row.id)?.status ?? "stopped"}.`);
      }
      const j = find(p.id, c, p.action);
      if (j.status && (p.action === "wait" || !lingers(j))) return reply(withTail(j));
      j.waiters++;
      try {
        if (p.action === "stop") await stop(j);
        else {
          const seconds = Math.min(3600, Math.max(10, p.timeout ?? 30));
          // Cancelling ends only the wait: the job keeps running.
          await new Promise<void>((resolve, reject) => {
            const end = (error?: Error) => {
              timers().clearTimeout(timer);
              signal?.removeEventListener("abort", cancel);
              if (error) reject(error);
              else resolve();
            };
            const cancel = () => end(new Error(`Wait cancelled. Job ${j.id} is still running.`));
            const timer = timers().setTimeout(() => end(), seconds * 1000);
            signal?.addEventListener("abort", cancel, { once: true });
            void j.done.then(() => end());
            if (signal?.aborted) cancel();
          });
        }
      } finally {
        j.waiters--;
      }
      return reply(withTail(j));
    },
    ...toolRenderers({
      title: "Jobs",
      arg: (a: any) => [a?.action, a?.id].filter(Boolean).join(" "),
      summary: { verb: "managed", one: "job" },
      result: (r: any, _a, _e, theme) => {
        const [first = "", ...rest] = clean(resultText(r)).split("\n");
        return { summary: first, body: rest.map((l) => theme.fg("toolOutput", l)) };
      },
    }),
  } as any);

  // Crash clean-up: groups left by a Pi that was killed.
  pi.on("session_start", () => reap());

  const off = section.onChange((key) => {
    if (key === "autoBackgroundSeconds") pi.registerTool(bashTool() as any);
    if (key === "maxJobs") setGroupLimit((section.get("maxJobs") as number | undefined) ?? MAX_GROUPS);
  });

  // Jobs belong to this session: shutdown, reload and session switch kill every one.
  pi.on("session_shutdown", async () => {
    off();
    closing = true;
    await Promise.all([...jobs.values()].map(stop));
    jobs.clear();
    dir.remove();
  });
}
