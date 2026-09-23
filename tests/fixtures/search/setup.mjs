// Shared setup for the search tests: a git fixture repo and FFF spies at the binding boundary.
import { cpSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FileFinder } from "@ff-labs/fff-node";

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
// hooks.waitForScan(real, ms) may replace the scan wait.
export function spyFFF(hooks = {}) {
  const spy = { calls: [], finders: [], created: 0 };
  spy.FileFinder = {
    isAvailable: () => FileFinder.isAvailable(),
    create(opts) {
      spy.created++;
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
