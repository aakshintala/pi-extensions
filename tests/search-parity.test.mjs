// Parity: on the fixture repo, the FFF-backed tools return the same lines as Pi's built-in
// grep (ripgrep) and find (fd), up to ordering. CI installs ripgrep and fd-find; a machine
// without them skips the affected half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFindTool, createGrepTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { makeRepo, spyFFF } from "./fixtures/search/setup.mjs";
import { searchExtension } from "../extensions/search/index.ts";

process.env.PI_OFFLINE = "1"; // never download rg/fd
const has = (...names) => names.some((n) => existsSync(join(getAgentDir(), "bin", n)) || !spawnSync(n, ["--version"]).error);

const GREP = [
  { pattern: "token", ignoreCase: false },
  { pattern: "TOKEN", ignoreCase: true },
  { pattern: "Token" },
  { pattern: "fo+\\.bar" },
  { pattern: "foo.bar()", literal: true },
  { pattern: "token", glob: "*.js", ignoreCase: false },
  { pattern: "test", glob: "**/*.spec.ts" }, // a rooted glob like src/**/*.ts matches nothing in the built-in
  { pattern: "Token", path: "src" },
  { pattern: "token", path: "lib/util.js", ignoreCase: false },
  { pattern: "TODO", context: 1 },
  { pattern: "item", limit: 2 },
  { pattern: "absent" },
];
const FIND = [
  { pattern: "*.ts" },
  { pattern: "*.js" },
  { pattern: "src/**/*.ts" },
  { pattern: "**/handler.ts" },
  { pattern: "*.ts", path: "src" },
  { pattern: "*.{md,js}" },
  { pattern: "*.nope" },
];

async function setup(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-parity-")));
  makeRepo(cwd);
  const spy = spyFFF();
  const tools = {};
  const on = {};
  searchExtension(spy.load)({ on: (e, h) => (on[e] = h), registerTool: (d) => (tools[d.name] = d) });
  const ctx = { cwd, ui: { notify: () => assert.fail("fell back") } };
  on.session_start({}, ctx);
  t.after(() => (on.session_shutdown(), rmSync(cwd, { recursive: true, force: true })));
  const text = async (tool, args) => (await tool.execute("id", args, undefined, undefined, ctx)).content[0].text;
  // Result lines, sorted; the limit notice stays at the end.
  const lines = (s) => {
    const [body, notice] = s.split("\n\n");
    return [...body.split("\n").sort(), notice].filter(Boolean).join("\n");
  };
  return { cwd, spy, tools, text, lines };
}

test("grep matches Pi's built-in grep", { skip: !has("rg") && "ripgrep not installed" }, async (t) => {
  const { cwd, spy, tools, text, lines } = await setup(t);
  const builtin = createGrepTool(cwd);
  // The built-in's rg --hidden also searches .git/ internals; FFF never indexes .git/.
  const noGit = (s) => s.split("\n").filter((l) => !l.startsWith(".git/")).join("\n") || "No matches found";
  for (const args of GREP) {
    assert.equal(lines(await text(tools.grep, args)), lines(noGit(await text(builtin, args))), JSON.stringify(args));
  }
  assert.equal(spy.calls.length, GREP.length);
});

test("find matches Pi's built-in find", { skip: !has("fd", "fdfind") && "fd not installed" }, async (t) => {
  const { cwd, spy, tools, text, lines } = await setup(t);
  const builtin = createFindTool(cwd);
  for (const args of FIND) {
    assert.equal(lines(await text(tools.find, args)), lines(await text(builtin, args)), JSON.stringify(args));
  }
  assert.equal(spy.calls.length, FIND.length);
});
