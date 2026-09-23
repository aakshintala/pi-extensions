// Process groups of background work (#49): tracking, crash records and their reaping, the
// cap on running groups and the output cap. Used by extensions/jobs and extensions/monitor.
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output past this stops a job or monitor: Claude Code's kill threshold. */
export const MAX_OUTPUT_BYTES = 5 * 1024 ** 3;
/** Default most counted groups alive at once. The measured peak in the user's Pi logs is 10. */
export const MAX_GROUPS = 16;
/** Temp directory prefixes whose `*.pid` crash records `reap` reads. */
const PREFIXES = ["pi-jobs-", "pi-monitor-"];

/** A detached child's process group, from `track` until `groupOf` sees it empty. */
export type Group = {
  child: ChildProcess;
  /** The group id, until the group is seen empty. */
  pgid?: number;
  /** Its crash record: `<id>.pid` in a `pi-jobs-*` or `pi-monitor-*` directory of `tmpdir()`, made by mkdtemp. */
  record: string;
  /** Counts toward the cap while the group is alive. */
  counted?: boolean;
};

type State = { live: Set<Group>; limit: number; piStart?: string };
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

/** Sends `signal` to process group `pgid`; nothing if it is undefined, 1 or less, or gone. */
export function signalGroup(pgid: number | undefined, signal: NodeJS.Signals) {
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

/** A process's start time as `ps` prints it, or undefined when it cannot be read. */
const PS = ["-o", "lstart=", "-p"];
const PS_ENV = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
export function startTimeSync(pid: number) {
  try {
    return execFileSync("ps", [...PS, String(pid)], { env: PS_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {}
}
export const startTime = (pid: number) =>
  new Promise<string | undefined>((resolve) => execFile("ps", [...PS, String(pid)], { env: PS_ENV() }, (error, out) => resolve(error ? undefined : out.trim() || undefined)));

/**
 * Starts tracking a group: the exit handler kills it, it counts toward the cap if `counted`,
 * and its crash record is written now, before anything can kill this Pi: the group, its
 * leader's start time, and this Pi's pid and start time. Returns `g`.
 * ponytail: two `ps` runs per spawn (one after the first), a few ms each.
 */
export function track<G extends Group>(g: G): G {
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
export function groupOf(g: Group) {
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

/** Whether `file` has passed MAX_OUTPUT_BYTES. */
export function pastOutputCap(file: string) {
  try {
    return statSync(file).size > MAX_OUTPUT_BYTES;
  } catch {
    return false;
  }
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
 */
export async function reap() {
  const root = tmpdir();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => PREFIXES.some((p) => d.startsWith(p)) && mine(join(root, d), true, 0o700));
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
