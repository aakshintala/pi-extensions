// Git worktrees for subagents spawned with isolation "worktree" (#54). Each one is made
// from the parent's HEAD on the new branch subagent/<id>, in <agent dir>/rig-worktrees/<id>,
// so no two agents share a path or a branch. Nothing is committed for the child.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (args: string[], cwd?: string) => (await exec("git", args, { cwd })).stdout.trim();
const why = (e: any) => String(e?.stderr || e?.message || e).trim().split("\n")[0];

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

/** Makes agent `id`'s worktree from the HEAD of the repository holding `cwd`. Throws outside a repository. */
export async function createWorktree(cwd: string, dir: string, id: string): Promise<Worktree> {
  let top: string, common: string, base: string;
  try {
    [top, common, base] = (await git(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--verify", "HEAD"], cwd)).split("\n");
  } catch (e) {
    throw new Error(`Isolation "worktree" needs a git repository with a commit, and ${cwd} has none (${why(e)}). Use isolation "none".`);
  }
  const path = join(dir, id);
  const w = { git: common, path, branch: `subagent/${id}`, base, cwd: join(path, relative(top, realpathSync(cwd))) };
  try {
    await git(["--git-dir", common, "worktree", "add", "-q", "-b", w.branch, path, base]);
  } catch (e) {
    throw new Error(`Could not create the worktree: ${why(e)}`);
  }
  return w;
}

/** Brings back a worktree removed when its agent last finished, on its own branch, for a resume. */
export async function reopenWorktree(w: Worktree) {
  if (existsSync(w.path)) return;
  const branch = await git(["--git-dir", w.git, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]).catch(() => "");
  await git(["--git-dir", w.git, "worktree", "add", "-q", ...(branch ? [w.path, w.branch] : ["-b", w.branch, w.path, w.base])]);
}

/**
 * Removes the worktree when nothing in it would be lost, and says what happened. It is kept
 * with uncommitted changes (untracked files included) or with commits no remote has; its
 * branch is deleted too when it never moved from the base.
 */
export async function settleWorktree(w: Worktree): Promise<string> {
  const at = `Worktree: ${w.path} (branch ${w.branch})`;
  try {
    if (!existsSync(w.path)) return `${at}, already gone.`;
    if (await git(["status", "--porcelain"], w.path)) return `${at}, kept: it has uncommitted changes.`;
    if (await git(["rev-list", "-n1", "HEAD", "--not", w.base, "--remotes"], w.path)) return `${at}, kept: it has unpushed commits.`;
    // Without --force, git itself refuses a tree that changed since the check.
    await git(["--git-dir", w.git, "worktree", "remove", w.path]);
    const tip = await git(["--git-dir", w.git, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]).catch(() => "");
    if (tip === w.base) await git(["--git-dir", w.git, "branch", "-D", w.branch]).catch(() => undefined); // an unmoved branch holds nothing
    return `${at}, removed: nothing uncommitted or unpushed${tip && tip !== w.base ? "; the branch is kept" : ""}.`;
  } catch (e) {
    return `${at}, kept: ${why(e)}`;
  }
}
