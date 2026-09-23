// Shared setup for the search tests: a git fixture repo and FFF spies at the binding boundary.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { FileFinder } from "@ff-labs/fff-node";
import "../tool-display/pi-tui.mjs"; // before the extension, which draws with pi-tui
const { searchExtension } = await import("../../../extensions/search/index.ts");

const FIXTURE = new URL("./repo", import.meta.url).pathname;

// Copies the fixture into dir as a git repo: build/ is gitignored, b/handler.ts is modified.
export function makeRepo(dir) {
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build", "out.js"), "token in build\n");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  appendFileSync(join(dir, "b", "handler.ts"), "export const changed = 1;\n");
}

// The real FileFinder, with every finder it creates recorded and its search calls logged.
// hooks.waitForScan(real, ms) may replace the scan wait. hooks.strictDb makes create fail
// when the frecency database's directory is missing.
export function spyFFF(hooks = {}) {
  const spy = { calls: [], finders: [], created: 0, opts: [] };
  spy.FileFinder = {
    isAvailable: () => FileFinder.isAvailable(),
    create(opts) {
      spy.created++;
      spy.opts.push(opts);
      if (hooks.strictDb && opts.frecencyDbPath && !existsSync(dirname(opts.frecencyDbPath))) return { ok: false, error: "no db dir" };
      const made = FileFinder.create(opts);
      if (!made.ok) return made;
      const f = made.value;
      for (const m of ["grep", "glob", "fileSearch"]) {
        const real = f[m].bind(f);
        f[m] = (query, o) => (spy.calls.push([m, query]), real(query, o));
      }
      if (hooks.waitForScan) {
        const real = f.waitForScan.bind(f);
        f.waitForScan = (ms) => hooks.waitForScan(real, ms);
      }
      spy.finders.push(f);
      return made;
    },
  };
  spy.load = async () => spy.FileFinder;
  return spy;
}

// A fresh fixture repo in a temp dir, removed after the test.
export function tempRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-search-")));
  makeRepo(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The extension against a minimal stand-in for Pi: start(cwd) emits session_start,
// run(tool, args, signal) returns the result text, notices collects ctx.ui.notify.
export function direct(t, load, opts) {
  const tools = {};
  const on = {};
  const notices = [];
  searchExtension(load, opts)({ on: (e, h) => (on[e] = h), registerTool: (d) => (tools[d.name] = d) });
  const ctx = { cwd: "", ui: { notify: (m) => notices.push(m) } };
  t.after(() => on.session_shutdown());
  return {
    ctx,
    notices,
    tools,
    start: (cwd) => on.session_start({ type: "session_start" }, Object.assign(ctx, { cwd })),
    shutdown: () => on.session_shutdown(),
    run: async (name, args, signal) => (await tools[name].execute("id", args, signal, undefined, ctx)).content[0].text,
  };
}
