// Process groups of background work (#49): spawning, killing, tracking, crash records and
// their reaping, the cap on running groups and the output cap. Used by extensions/jobs and
// extensions/monitor. Every timer runs on the seam below.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** Output past this stops a job or monitor: Claude Code's kill threshold. */
export const MAX_OUTPUT_BYTES = 5 * 1024 ** 3;
/** MAX_OUTPUT_BYTES as its messages say it. */
export const MAX_OUTPUT = `${MAX_OUTPUT_BYTES / 1024 ** 3} GB`;
/** Default most counted groups alive at once. The measured peak in the user's Pi logs is 10. */
export const MAX_GROUPS = 16;
/** Grace between SIGTERM and SIGKILL to a group. */
const KILL_MS = 800;
/** How often a killed group is checked until its zombies are reaped. */
const ZOMBIE_MS = 10;
const MAX_TIMER_MS = 2 ** 31 - 1;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
/** Every timer of jobs, monitor and the kills here. Tests replace them through this symbol. */
export const timers = (): Timers => (globalThis as any)[Symbol.for("pi-rig.timers")] ?? globalThis;
// Referenced: a headless Pi must not exit before a pending SIGKILL fires.
const delay = (ms: number) => new Promise<void>((r) => timers().setTimeout(r, Math.min(ms, MAX_TIMER_MS)));

/** A detached child's process group, from `track` until `groupOf` sees it empty. */
type Group = {
  child: ChildProcess;
  /** The group id, until the group is seen empty. */
  pgid?: number;
  /** Its crash record, in a `logDir`. */
  record: string;
  /** Counts toward the cap while the group is alive. */
  counted: boolean;
};

type State = { live: Set<Group>; limit: number; piStart?: string; reaped?: boolean };
const KEY = Symbol.for("pi-rig.process-groups");
/**
 * One per process, whatever loads this module: the live groups, with one `exit` handler
 * that SIGKILLs them (a crash or a hard exit skips `session_shutdown`), and the cap.
 */
function state(): State {
  const g = globalThis as { [KEY]?: State };
  if (!g[KEY]) {
    const s = (g[KEY] = { live: new Set<Group>(), limit: MAX_GROUPS });
    process.on("exit", () => {
      for (const group of s.live) signalGroup(groupOf(group), "SIGKILL");
    });
  }
  return g[KEY];
}

/** The kinds whose `pi-<kind>-*` directories `reap` reads. */
const KINDS = ["jobs", "monitor"] as const;

/** A session's log directory, `pi-<kind>-*` under `tmpdir()`, made on first use. */
export function logDir(kind: (typeof KINDS)[number]) {
  let dir: string | undefined;
  return {
    path: (file: string) => join((dir ??= mkdtempSync(join(tmpdir(), `pi-${kind}-`))), file),
    /** Removes the directory unless a log is left in it: those are left for the OS to clean. */
    remove() {
      try {
        if (dir) rmdirSync(dir);
      } catch {}
    },
  };
}

/**
 * Runs `command` in Pi's shell as its own process group, tracked until the group is empty,
 * with a crash record `<id>.pid` in `dir`. Stdout goes to the `stdout` file (appended) or a
 * pipe, stderr to the `stderr` file. `exited` gives the shell's exit code (128 + signal,
 * 127 when it could not start); `closed` resolves when its stdio has closed.
 */
export function spawnGroup(o: { command: string; cwd: string; env?: NodeJS.ProcessEnv; dir: ReturnType<typeof logDir>; id: string; stdout?: string; stderr: string; counted: boolean }) {
  const shell = getShellConfig();
  const stdin = shell.commandTransport === "stdin";
  const fds = [o.stdout, o.stderr].map((f) => (f === undefined ? undefined : openSync(f, "a", 0o600)));
  let child: ChildProcess;
  try {
    child = spawn(shell.shell, stdin ? shell.args : [...shell.args, o.command], { cwd: o.cwd, env: o.env, detached: true, stdio: [stdin ? "pipe" : "ignore", fds[0] ?? "pipe", fds[1]!] });
  } finally {
    for (const fd of fds) if (fd !== undefined) closeSync(fd);
  }
  if (stdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.command);
  }
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0)));
    child.once("error", () => resolve(127));
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const g = track({ child, pgid: child.pid, record: o.dir.path(`${o.id}.pid`), counted: o.counted });
  let killing: Promise<void> | undefined;
  return {
    child,
    exited,
    closed,
    /** Whether the group may still hold processes, the shell's leftovers included. */
    alive: () => !!groupOf(g),
    /** Counts the group toward the cap from now on. */
    count: () => void (g.counted = true),
    /**
     * SIGTERM to the group; if any of it is alive after KILL_MS, SIGKILL until it is empty.
     * The group, not the shell: what the shell left behind is signalled after it exits. A
     * process that calls setsid leaves the group, and nothing here reaches it.
     */
    kill: () =>
      (killing ??= (async () => {
        signalGroup(groupOf(g), "SIGTERM");
        const grace = delay(KILL_MS);
        await Promise.race([closed, grace]);
        if (groupOf(g)) {
          await grace;
          signalGroup(groupOf(g), "SIGKILL");
          // Killed processes linger briefly as zombies until init reaps them.
          for (let i = 0; i < 100 && groupOf(g); i++) await delay(ZOMBIE_MS);
        }
      })().finally(() => (killing = undefined))),
  };
}

/** Sends `signal` to process group `pgid`; nothing if it is undefined, 1 or less, or gone. */
function signalGroup(pgid: number | undefined, signal: NodeJS.Signals) {
  try {
    if (pgid && pgid > 1) process.kill(-pgid, signal);
  } catch {}
}

/** Whether signal 0 reaches `pid` (a group when negative) as ours: EPERM means someone else's. */
const ours = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A process's start time as `ps` prints it, or undefined when it cannot be read in PS_MS. */
const PS = ["-o", "lstart=", "-p"];
const PS_MS = 1000;
const PS_ENV = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
export function startTimeSync(pid: number) {
  try {
    return execFileSync("ps", [...PS, String(pid)], { env: PS_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PS_MS }).trim() || undefined;
  } catch {}
}
const startTime = (pid: number) =>
  new Promise<string | undefined>((resolve) => execFile("ps", [...PS, String(pid)], { env: PS_ENV(), timeout: PS_MS }, (error, out) => resolve(error ? undefined : out.trim() || undefined)));

/**
 * Starts tracking a group: the exit handler kills it, it counts toward the cap if `counted`,
 * and its crash record is written now, before anything can kill this Pi: the group, its
 * leader's start time, and this Pi's pid and start time.
 * ponytail: two `ps` runs per spawn (one after the first), a few ms each; a hung `ps` is cut
 * at PS_MS, and the group then has no record: its start time is unknown, so it is never reaped.
 */
function track(g: Group) {
  if (!g.pgid || g.pgid <= 1) return ((g.pgid = undefined), g);
  const s = state();
  s.live.add(g);
  s.piStart ??= startTimeSync(process.pid);
  const start = startTimeSync(g.pgid);
  if (s.piStart && start) writeFileSync(g.record, JSON.stringify({ pi: process.pid, piStart: s.piStart, pgid: g.pgid, start }), { mode: 0o600 });
  return g;
}

/**
 * The group's id while it may hold processes, or undefined. Until the leader is reaped its
 * pid, and so the group id, cannot be reused. After that a process with that pid means the
 * id was reused and the group is not ours. A group seen empty (or not ours) is forgotten,
 * with its crash record, and its id is never signalled again.
 */
function groupOf(g: Group) {
  const id = g.pgid;
  if (!id) return;
  const reaped = g.child.exitCode !== null || g.child.signalCode !== null;
  if (ours(-id) && (!reaped || !ours(id))) return id;
  g.pgid = undefined;
  state().live.delete(g);
  rmSync(g.record, { force: true });
}

/** Sets the cap on counted groups; extensions/jobs sets it from `maxJobs`. */
export function setGroupLimit(n: number) {
  state().limit = n;
}

/**
 * Why a new job or monitor may not start: undefined, or the refusal once the cap's worth of
 * counted groups are alive, including groups whose shell exited but whose children run on.
 */
export function tooManyJobs() {
  const s = state();
  const alive = [...s.live].filter((g) => g.counted && groupOf(g)).length;
  if (alive >= s.limit) return `Not started: ${alive} jobs and monitors are running, the most allowed. Wait for one or stop one with jobs, then retry.`;
}

/** A directory or file owned by this user with exactly `mode`, and not a link. */
const mine = (path: string, dir: boolean, mode: number) => {
  try {
    const st = lstatSync(path);
    return (dir ? st.isDirectory() : st.isFile()) && st.uid === process.getuid?.() && (st.mode & 0o777) === mode;
  } catch {
    return false;
  }
};

/** Whether the Pi of a record has ended: its pid is gone, or now belongs to a later process. Unknown counts as running. */
async function ended(pid: number, start: string) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  const now = await startTime(pid);
  return now !== undefined && now !== start;
}

/**
 * Kills groups left by a Pi that died without its exit handler (SIGKILL, power loss). Only
 * this user's 0700 directories and 0600 records are read, so another user cannot plant one.
 * A group is killed only while its leader is the recorded process, same pid and start time,
 * so a reused pid is never signalled; a group whose leader already exited is left. A
 * malformed record is deleted; one whose state cannot be read is kept for the next start.
 * Runs once per process: every later call, such as each subagent's session start, is a no-op.
 */
export async function reap() {
  const s = state();
  if (s.reaped) return;
  s.reaped = true;
  const root = tmpdir();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => KINDS.some((k) => d.startsWith(`pi-${k}-`)) && mine(join(root, d), true, 0o700));
  } catch {}
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith(".pid") && mine(join(root, d, f), false, 0o600));
    } catch {}
    for (const f of files) {
      const file = join(root, d, f);
      let r: { pi: number; piStart: string; pgid: number; start: string };
      try {
        r = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      const valid = Number.isInteger(r?.pi) && r.pi > 0 && Number.isInteger(r.pgid) && r.pgid > 1 && typeof r.piStart === "string" && typeof r.start === "string" && !!r.start;
      if (!valid) {
        rmSync(file, { force: true });
        continue;
      }
      if (!(await ended(r.pi, r.piStart))) continue;
      const leader = await startTime(r.pgid);
      if (leader === r.start) signalGroup(r.pgid, "SIGKILL");
      else if (leader === undefined && ours(r.pgid)) continue; // alive but unreadable: try again next start
      rmSync(file, { force: true });
    }
  }
}
