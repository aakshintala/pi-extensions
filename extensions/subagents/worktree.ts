// Git worktrees for subagents spawned with isolation "worktree" (#54). Each one is made
// from the parent's HEAD on the new branch subagent/<id>, in <agent dir>/rig-worktrees/<id>,
// so no two agents share a path or a branch. Nothing is committed for the child. Git runs
// through shared/git: the repository's hooks, fsmonitor and filters never run, and a hung
// git is stopped.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { blankRepoFilters, runGit } from "../../shared/git/index.ts";

/** A checkout can take a while; a git hung on LFS or NFS is stopped after this. */
const LIMITS = { timeoutMs: 120_000, graceMs: 2_000 };
const never = new AbortController().signal;
const STOPPED = "git timed out or was stopped";

async function git(args: string[], cwd: string, signal = never) {
  const r = await runGit(args, cwd, signal, { limits: LIMITS });
  if (r.ok) return r.out.trim();
  throw new Error(r.stopped ? STOPPED : r.err.trim().split("\n")[0] || `git ${args.find((a) => !a.startsWith("-"))} failed`);
}

/** git for a command that reads or writes file contents: the repository's own filters blanked. */
async function contents(args: string[], cwd: string, signal = never) {
  const blank = await blankRepoFilters(cwd, signal, LIMITS);
  if (!blank) throw new Error(STOPPED);
  return git([...blank, ...args], cwd, signal);
}

const inside = (dir: string, path: string) => {
  const r = relative(dir, path);
  return !isAbsolute(r) && r.split(sep)[0] !== "..";
};

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Saved in the child's rig.subagent entry, so a resume after a restart finds it. */
export type Worktree = {
  /** The repository's common git dir: git commands run against it, from anywhere. */
  git: string;
  path: string;
  branch: string;
  /** The commit it was made from. */
  base: string;
  /** Where the child works: the parent's cwd, mapped into the worktree. */
  cwd: string;
};

/** Makes agent `id`'s worktree in `dir` from the HEAD of the repository holding `cwd`. Throws outside a repository. */
export async function createWorktree(cwd: string, dir: string, id: string, signal = never): Promise<Worktree> {
  let top: string, common: string, base: string;
  try {
    [top, common, base] = (await git(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--verify", "HEAD"], cwd, signal)).split("\n");
  } catch (e) {
    if ((e as Error).message === STOPPED) throw new Error(`Could not create the worktree: ${STOPPED}.`);
    throw new Error(`Isolation "worktree" needs a git repository with a commit, and ${cwd} has none (${(e as Error).message}). Use isolation "none".`);
  }
  const path = join(dir, id);
  const w = { git: common, path, branch: `subagent/${id}`, base, cwd: join(path, relative(top, realpathSync(cwd))) };
  if (!inside(path, w.cwd)) throw new Error(`${cwd} is not inside its repository ${top}.`);
  try {
    await contents(["--git-dir", common, "worktree", "add", "-q", "-b", w.branch, path, base], common, signal);
  } catch (e) {
    throw new Error(`Could not create the worktree ${path}: ${(e as Error).message}`);
  }
  return w;
}

/**
 * A worktree read from a session file, checked against what the spawn makes for agent
 * `id` in `dir` and the repository holding `cwd`. Throws on anything else, so a
 * tampered file never points git at another path or branch.
 */
export async function checkWorktree(w: any, id: string, dir: string, cwd: string): Promise<Worktree> {
  const path = join(dir, id);
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).catch(() => "");
  const ok =
    /^[0-9a-f]{8}$/.test(id) && w?.path === path && w.branch === `subagent/${id}` && common && w.git === common &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(w.base) && typeof w.cwd === "string" && inside(path, w.cwd);
  if (!ok) throw new Error(`Subagent ${id}'s saved worktree is not the one its spawn made in this repository, so it is not resumed.`);
  return { git: common, path, branch: w.branch, base: w.base, cwd: w.cwd };
}

/** Makes sure the worktree is at its path for a run: brought back on its own branch if it was removed, refused if something else is there. */
export async function reopenWorktree(w: Worktree) {
  if (existsSync(w.path) || isLink(w.path)) {
    const found = lstatSync(w.path).isDirectory()
      ? await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], w.path).catch(() => "")
      : "";
    if (found !== `${w.git}\n${realpathSync(w.path)}`) throw new Error(`${w.path} is not this agent's worktree, so it does not run there.`);
    return;
  }
  // Drops git's record of a worktree whose directory was deleted, which would block the add.
  await git(["--git-dir", w.git, "worktree", "prune"], w.git);
  const branch = await git(["--git-dir", w.git, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`], w.git).catch(() => "");
  await contents(["--git-dir", w.git, "worktree", "add", "-q", ...(branch ? [w.path, w.branch] : ["-b", w.branch, w.path, w.base])], w.git);
}

/**
 * Removes the worktree when nothing in it would be lost, and says what happened. It is kept
 * with uncommitted changes, untracked or ignored files, or commits no remote has. Its
 * branch is deleted too (safely, with -d) when it never moved from the base.
 */
export async function settleWorktree(w: Worktree): Promise<string> {
  const at = `Worktree: ${w.path} (branch ${w.branch})`;
  try {
    if (!existsSync(w.path)) return `${at}, already gone.`;
    // Ignored files count: removing the tree would delete them (.env, build output).
    if (await contents(["status", "--porcelain", "--ignored"], w.path)) return `${at}, kept: it has uncommitted changes or ignored files.`;
    if (await git(["rev-list", "-n1", "HEAD", "--not", w.base, "--remotes"], w.path)) return `${at}, kept: it has unpushed commits.`;
    // Without --force, git itself refuses a tree that changed since the check.
    await contents(["--git-dir", w.git, "worktree", "remove", w.path], w.git);
    const tip = await git(["--git-dir", w.git, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`], w.git).catch(() => "");
    const deleted = tip === w.base && (await git(["--git-dir", w.git, "branch", "-q", "-d", w.branch], w.git).then(() => true, () => false));
    return `${at}, removed: nothing uncommitted, ignored or unpushed${tip && !deleted ? "; the branch is kept" : ""}.`;
  } catch (e) {
    return `${at}, kept: ${(e as Error).message}`;
  }
}
