// Git that never runs a repository's own code (#89, #54): no fsmonitor, no hooks,
// no optional index writes, and every clean/smudge/process filter the repository
// configures itself blanked. The user's global and system config still apply.
// Every run is bounded: on timeout or abort git gets SIGTERM, then SIGKILL.
import { spawn } from "node:child_process";

const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"];

export type GitLimits = { timeoutMs: number; graceMs: number };
export const GIT_LIMITS: GitLimits = { timeoutMs: 5_000, graceMs: 2_000 };
/** `stopped`: timed out, aborted, or killed at its first output. `err` is its stderr. */
export type GitRun = { ok: boolean; out: string; err: string; stopped: boolean };

/**
 * Runs git with the safe config; resolves once it exits. After a stop, it resolves
 * at the end of the grace period even if git has not exited (e.g. stuck on NFS).
 * With `first`, kills git at its first output.
 */
export function runGit(args: string[], cwd: string, signal: AbortSignal, { first = false, limits = GIT_LIMITS } = {}) {
  return new Promise<GitRun>((resolve) => {
    let out = "";
    let err = "";
    let stopped = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const child = spawn("git", [...SAFE, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
      // Resolved before close (grace expired): a descendant may hold the pipes, so release our ends.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ok, out, err, stopped });
    };
    const stop = () => {
      stopped = true;
      child.kill();
      grace ??= setTimeout(() => {
        child.kill("SIGKILL");
        done(false);
      }, limits.graceMs);
    };
    const timer = setTimeout(stop, limits.timeoutMs);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop);
    child.stdout.on("data", (d) => {
      out += d;
      if (first) stop();
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => child.pid === undefined && done(false)); // never spawned: no close
    child.on("close", (code) => done(code === 0));
  });
}

/**
 * `-c filter.<name>.<key>=` for each filter the repository at `cwd` configures itself
 * (local or worktree scope, includes too), to put before a command that reads or
 * writes file contents. `undefined` when git could not tell (timed out or aborted).
 */
export async function blankRepoFilters(cwd: string, signal: AbortSignal, limits = GIT_LIMITS): Promise<string[] | undefined> {
  const scoped = await runGit(["config", "--includes", "--show-scope", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], cwd, signal, { limits });
  if (signal.aborted || scoped.stopped) return undefined;
  return scoped.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([scope, key]) => key && scope !== "global" && scope !== "system")
    .flatMap(([, key]) => ["-c", `${key}=`]);
}
