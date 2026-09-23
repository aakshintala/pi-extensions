// The footer's git dirty check against real repositories: a repo's own config
// must not run code, and a huge status output still reads as dirty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { gitDirty } = await import("./footer.ts");

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
