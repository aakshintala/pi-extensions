import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRigSettings } from "./index.ts";

const DECL = [
  { key: "maxConcurrent", type: "integer", min: 1, max: 32, default: 10, description: "Parallel subagents" },
  { key: "verbose", type: "boolean", default: false, description: "Verbose output" },
  { key: "mode", type: "enum", values: ["fast", "slow"], default: "fast", description: "Mode" },
];

function dir(file) {
  const d = mkdtempSync(join(tmpdir(), "rig-settings-"));
  if (file !== undefined) writeFileSync(join(d, "rig.json"), typeof file === "string" ? file : JSON.stringify(file));
  return d;
}
const readFile = (d) => JSON.parse(readFileSync(join(d, "rig.json"), "utf8"));
function load(d) {
  const rig = createRigSettings(d);
  const section = rig.declare("subagents", DECL);
  const warnings = [];
  rig.notifyWarnings({ notify: (m, type) => warnings.push([m, type]) });
  return { rig, section, warnings: warnings.map(([m]) => m), types: warnings.map(([, t]) => t) };
}
const DEFAULTS = { maxConcurrent: 10, verbose: false, mode: "fast" };

test("no file gives defaults and no warnings", () => {
  const { section, warnings } = load(dir());
  assert.deepEqual(section.values(), DEFAULTS);
  assert.deepEqual(warnings, []);
});

test("empty file gives defaults and no warnings", () => {
  const { section, warnings } = load(dir(""));
  assert.deepEqual(section.values(), DEFAULTS);
  assert.deepEqual(warnings, []);
});

test("partial section keeps file values and defaults the rest", () => {
  const { section, warnings } = load(dir({ subagents: { maxConcurrent: 4 } }));
  assert.deepEqual(section.values(), { ...DEFAULTS, maxConcurrent: 4 });
  assert.equal(section.get("maxConcurrent"), 4);
  assert.deepEqual(warnings, []);
});

for (const [name, bad, key] of [
  ["bad type", { maxConcurrent: "4" }, "maxConcurrent"],
  ["non-integer", { maxConcurrent: 2.5 }, "maxConcurrent"],
  ["out-of-range", { maxConcurrent: 33 }, "maxConcurrent"],
  ["bad boolean", { verbose: 1 }, "verbose"],
  ["value outside enum", { mode: "medium" }, "mode"],
  ["unknown key", { maxConcurent: 4 }, "maxConcurent"],
]) {
  test(`${name} gives one warning naming the key and the default`, () => {
    const { section, warnings, types } = load(dir({ subagents: { verbose: true, ...bad } }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`subagents\\.${key}`));
    assert.deepEqual(types, ["warning"]);
    assert.deepEqual(section.values(), { ...DEFAULTS, verbose: key === "verbose" ? false : true });
  });
}

test("invalid JSON gives one warning and all defaults, across several sections", () => {
  const d = dir("{ nope");
  const rig = createRigSettings(d);
  const a = rig.declare("subagents", DECL);
  const b = rig.declare("jobs", [{ key: "maxJobs", type: "integer", min: 1, max: 64, default: 16, description: "Jobs" }]);
  const warnings = [];
  rig.notifyWarnings({ notify: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rig\.json/);
  assert.deepEqual(a.values(), DEFAULTS);
  assert.equal(b.get("maxJobs"), 16);
});

test("a section that is not an object gives one warning and defaults", () => {
  const { section, warnings } = load(dir({ subagents: [1] }));
  assert.equal(warnings.length, 1);
  assert.deepEqual(section.values(), DEFAULTS);
});

test("warnings are delivered once", () => {
  const { rig, warnings } = load(dir({ subagents: { nope: 1 } }));
  assert.equal(warnings.length, 1);
  const again = [];
  rig.notifyWarnings({ notify: (m) => again.push(m) });
  assert.deepEqual(again, []);
});

test("declarations with bad defaults are refused", () => {
  const rig = createRigSettings(dir());
  assert.throws(() => rig.declare("x", [{ key: "n", type: "integer", min: 1, max: 5, default: 9, description: "n" }]));
});

test("set writes only non-default keys, atomically, and updates the value", () => {
  const d = dir();
  const { section } = load(d);
  section.set("maxConcurrent", 4);
  section.set("mode", "slow");
  section.set("mode", "fast");
  assert.deepEqual(readFile(d), { subagents: { maxConcurrent: 4 } });
  assert.equal(section.get("maxConcurrent"), 4);
  assert.deepEqual(readdirSync(d), ["rig.json"]);
});

test("set refuses invalid values and leaves the file alone", () => {
  const d = dir();
  const { section } = load(d);
  assert.throws(() => section.set("maxConcurrent", 0), /subagents\.maxConcurrent/);
  assert.throws(() => section.set("mode", "medium"));
  assert.throws(() => section.set("nope", 1));
  assert.equal(existsSync(join(d, "rig.json")), false);
  assert.equal(section.get("maxConcurrent"), 10);
});

test("two writers with stale snapshots changing different keys keep both changes", () => {
  const d = dir({ other: { keep: 1 } });
  const one = load(d).section;
  const two = load(d).section;
  one.set("maxConcurrent", 4);
  two.set("verbose", true);
  assert.deepEqual(readFile(d), { other: { keep: 1 }, subagents: { maxConcurrent: 4, verbose: true } });
});

test("set refuses to overwrite a file that is no longer valid JSON", () => {
  const d = dir();
  const { section } = load(d);
  writeFileSync(join(d, "rig.json"), "{ broken");
  assert.throws(() => section.set("maxConcurrent", 4), /rig\.json/);
  assert.equal(readFileSync(join(d, "rig.json"), "utf8"), "{ broken");
});

test("reset restores the default and removes the key and empty section", () => {
  const d = dir({ subagents: { maxConcurrent: 4 } });
  const { section } = load(d);
  section.reset("maxConcurrent");
  assert.equal(section.get("maxConcurrent"), 10);
  assert.deepEqual(readFile(d), {});
});

test("change listeners hear set and reset, and can unsubscribe", () => {
  const { section } = load(dir());
  const heard = [];
  const off = section.onChange((key, value) => heard.push([key, value]));
  section.set("maxConcurrent", 4);
  section.reset("maxConcurrent");
  off();
  section.set("verbose", true);
  assert.deepEqual(heard, [["maxConcurrent", 4], ["maxConcurrent", 10]]);
});

test("redeclaring a section re-reads the file and drops old listeners", () => {
  const d = dir();
  const rig = createRigSettings(d);
  const heard = [];
  rig.declare("subagents", DECL).onChange(() => heard.push("old"));
  writeFileSync(join(d, "rig.json"), JSON.stringify({ subagents: { mode: "slow" } }));
  const fresh = rig.declare("subagents", DECL);
  assert.equal(fresh.get("mode"), "slow");
  fresh.set("verbose", true);
  assert.deepEqual(heard, []);
});

test("sections lists declared sections with their settings for the menu", () => {
  const rig = createRigSettings(dir());
  rig.declare("subagents", DECL);
  assert.deepEqual(rig.sections().map((s) => [s.name, s.settings.map((x) => x.key)]), [
    ["subagents", ["maxConcurrent", "verbose", "mode"]],
  ]);
});

test("a project .pi/rig.json is ignored", () => {
  const agentDir = dir();
  const project = mkdtempSync(join(tmpdir(), "rig-project-"));
  mkdirSync(join(project, ".pi"));
  writeFileSync(join(project, ".pi", "rig.json"), JSON.stringify({ subagents: { maxConcurrent: 2 } }));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { section, warnings } = load(agentDir);
    assert.equal(section.get("maxConcurrent"), 10);
    assert.deepEqual(warnings, []);
  } finally {
    process.chdir(cwd);
  }
});

test("rigSettings is one instance per process, shared through globalThis", async () => {
  const d = dir();
  const a = (await import("./index.ts")).rigSettings(d);
  const b = (await import("./index.ts?copy")).rigSettings(d);
  assert.equal(a, b);
});

test("a redeclared section retires the old handle: it refuses writes and its listeners stay silent", () => {
  const d = dir();
  const rig = createRigSettings(d);
  const old = rig.declare("subagents", DECL);
  const heard = [];
  old.onChange(() => heard.push("old"));
  rig.declare("subagents", DECL);
  assert.throws(() => old.set("maxConcurrent", 4), /redeclared/);
  assert.throws(() => old.reset("maxConcurrent"), /redeclared/);
  assert.equal(existsSync(join(d, "rig.json")), false);
  assert.deepEqual(heard, []);
});

test("a section named __proto__ is an ordinary section", () => {
  const d = dir();
  const decl = [{ key: "n", type: "integer", min: 1, max: 9, default: 1, description: "n" }];
  const section = createRigSettings(d).declare("__proto__", decl);
  assert.equal(section.get("n"), 1);
  section.set("n", 4);
  assert.equal({}.n, undefined);
  assert.deepEqual(Object.entries(JSON.parse(readFileSync(join(d, "rig.json"), "utf8"))), [["__proto__", { n: 4 }]]);
  assert.equal(createRigSettings(d).declare("__proto__", decl).get("n"), 4);
});

for (const [bounds, bad, message] of [
  [{ min: 1 }, 0, "must be at least 1"],
  [{ max: 5 }, 6, "must be at most 5"],
  [{ min: 1, max: 5 }, 6, "must be between 1 and 5"],
]) {
  test(`an integer bound ${JSON.stringify(bounds)} warns "${message}"`, () => {
    const rig = createRigSettings(dir({ s: { n: bad } }));
    rig.declare("s", [{ key: "n", type: "integer", ...bounds, default: 3, description: "n" }]);
    const warnings = [];
    rig.notifyWarnings({ notify: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`s\\.n ${message};`));
  });
}

test("an open enum also accepts values its test passes, and names them in the warning", () => {
  const zone = {
    key: "zone", type: "enum", values: ["local"], default: "local", description: "Zone",
    other: { label: "an IANA zone", test: (v) => v === "Asia/Kolkata" },
  };
  const rig = createRigSettings(dir({ s: { zone: "Mars/Olympus" } }));
  const section = rig.declare("s", [zone]);
  const warnings = [];
  rig.notifyWarnings({ notify: (m) => warnings.push(m) });
  assert.equal(section.get("zone"), "local");
  assert.match(warnings[0], /s\.zone must be one of local or an IANA zone;/);
  section.set("zone", "Asia/Kolkata");
  assert.equal(section.get("zone"), "Asia/Kolkata");
  assert.throws(() => section.set("zone", 5), /must be one of local or an IANA zone/);
});
