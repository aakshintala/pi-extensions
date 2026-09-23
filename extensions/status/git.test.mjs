// The footer's git dirty check against real repositories: a repo's own config
// must not run code, a huge status output still reads as dirty, and a hung git
// is killed without holding the process-wide lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../tests/fixtures/tool-display/pi-tui.mjs"; // before the footer, which draws with pi-tui

const { gitDirty, registerFooter } = await import("./footer.ts");

const dirty = (cwd) => gitDirty(cwd, new AbortController().signal);

function repo(t) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-status-git-")));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const cwd = join(box, "repo");
  mkdirSync(cwd);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  return { box, cwd, git };
}

test("clean, dirty and not a repository", async (t) => {
  const { box, cwd } = repo(t);
  assert.equal(await dirty(cwd), false);
  writeFileSync(join(cwd, "b.txt"), "b\n");
  assert.equal(await dirty(cwd), true);
  assert.equal(await dirty(box), null, "git fails outside a repository");
});

test("a repo's fsmonitor, hooks and clean filters never run", async (t) => {
  const { box, cwd, git } = repo(t);
  const marks = join(box, "marks");
  mkdirSync(marks);
  const script = (name, body = "") => {
    const path = join(box, name);
    writeFileSync(path, `#!/bin/sh\ntouch '${join(marks, name)}'\n${body}`);
    chmodSync(path, 0o755);
    return path;
  };
  git("config", "core.fsmonitor", script("fsmonitor", "exit 1\n"));
  writeFileSync(join(cwd, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch '${join(marks, "hook")}'\n`);
  chmodSync(join(cwd, ".git", "hooks", "post-index-change"), 0o755);
  // The filter comes from an included file, so only a scope-aware check finds it.
  writeFileSync(join(cwd, ".git", "evil.inc"), `[filter "evil"]\n\tclean = ${script("filter", "cat\n")}\n`);
  git("config", "include.path", "evil.inc");
  writeFileSync(join(cwd, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  const touch = (s) => utimesSync(join(cwd, "a.txt"), s, s); // new mtime, same content: status must hash a.txt

  // The traps work: plain git status runs all three.
  touch(2_000_000_000);
  git("status", "--porcelain");
  assert.deepEqual(["fsmonitor", "hook", "filter"].filter((m) => existsSync(join(marks, m))), ["fsmonitor", "hook", "filter"]);
  rmSync(marks, { recursive: true });
  mkdirSync(marks);

  touch(2_000_000_100);
  assert.equal(await dirty(cwd), true);
  assert.deepEqual(["fsmonitor", "hook", "filter"].filter((m) => existsSync(join(marks, m))), []);
});

test("status output over 1 MiB still reads as dirty", async (t) => {
  const { cwd } = repo(t);
  const pad = "x".repeat(80);
  for (let i = 0; i < 14_000; i++) writeFileSync(join(cwd, `${pad}${i}`), "");
  assert.equal(await dirty(cwd), true);
});

// A git that ignores SIGTERM and never exits on its own, like one stuck on a
// dead NFS mount or behind a TERM-trapping filter. A descendant (think: a
// filter process) holds its stdout open, so even after SIGKILL the pipe never
// closes. Records "gitpid descendantpid" per run.
function hungGit(t) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-status-hung-")));
  const pids = join(bin, "pids");
  writeFileSync(join(bin, "git"), `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho $$ $! >> '${pids}'\nexec sleep 30\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const runs = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map((l) => l.split(" ").map(Number)) : []);
  t.after(() => {
    process.env.PATH = path;
    for (const pid of runs().flat()) try { process.kill(pid, "SIGKILL"); } catch {}
    rmSync(bin, { recursive: true, force: true });
  });
  return runs;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Polls a condition (10 ms poll interval, not a sync point) with a deadline.
async function until(ok, what, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
// Stopped by abort, only once the fake git has trapped TERM (it records its
// pid after the trap), so the kill never races the script's start-up. The
// timeout takes the same path.
const LIMITS = { timeoutMs: 60_000, graceMs: 100 };

test("a git that ignores SIGTERM is killed, and the check resolves though its pipe stays open", { timeout: 20_000 }, async (t) => {
  const runs = hungGit(t);
  const stop = new AbortController();
  const check = gitDirty(tmpdir(), stop.signal, LIMITS);
  await until(() => runs().length === 1, "git to start");
  stop.abort();
  assert.equal(await check, null);
  await until(() => !alive(runs()[0][0]), "git to die");
});

test("a hung git releases the process-wide lock for the next footer", { timeout: 20_000 }, async (t) => {
  const runs = hungGit(t);
  const footer = () => {
    const handlers = {};
    registerFooter({ on: (n, f) => (handlers[n] ??= []).push(f), getThinkingLevel: () => "off" }, { gitDirty: (cwd, s) => gitDirty(cwd, s, LIMITS) });
    const ctx = { mode: "tui", isProjectTrusted: () => true, getContextUsage: () => undefined, sessionManager: { getBranch: () => [], getCwd: () => tmpdir() }, ui: { setFooter() {} } };
    return async (n) => {
      for (const f of handlers[n] ?? []) await f({ type: n }, ctx);
    };
  };
  const [a, b] = [footer(), footer()];
  await a("session_start");
  await b("session_start");
  await until(() => runs().length === 1, "the first footer's git to start");
  await a("session_shutdown");
  await until(() => runs().length === 2, "the second footer's git, once the first is killed");
  await b("session_shutdown");
  await until(() => runs().every(([git]) => !alive(git)), "both gits to die");
});
