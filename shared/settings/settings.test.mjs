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

test("redeclaring a section re-reads the file into the same handle and tells its listeners", () => {
  const d = dir();
  const rig = createRigSettings(d);
  const heard = [];
  const old = rig.declare("subagents", DECL);
  old.onChange((k, v) => heard.push([k, v]));
  writeFileSync(join(d, "rig.json"), JSON.stringify({ subagents: { mode: "slow" } }));
  const fresh = rig.declare("subagents", DECL);
  assert.equal(fresh, old);
  assert.equal(old.get("mode"), "slow");
  assert.deepEqual(heard, [["mode", "slow"]]);
});

test("two declares of a section share values and listeners, and a change through either or through sections() reaches both", () => {
  const d = dir();
  const rig = createRigSettings(d);
  const parent = rig.declare("subagents", DECL);
  const heard = [];
  parent.onChange((k, v) => heard.push(["parent", k, v]));
  const child = rig.declare("subagents", DECL);
  child.onChange((k, v) => heard.push(["child", k, v]));
  parent.set("maxConcurrent", 4);
  child.set("verbose", true);
  rig.sections()[0].reset("maxConcurrent");
  assert.deepEqual(heard, [
    ["parent", "maxConcurrent", 4], ["child", "maxConcurrent", 4],
    ["parent", "verbose", true], ["child", "verbose", true],
    ["parent", "maxConcurrent", 10], ["child", "maxConcurrent", 10],
  ]);
  assert.deepEqual(parent.values(), child.values());
  assert.deepEqual(rig.sections().length, 1);
  assert.deepEqual(readFile(d), { subagents: { verbose: true } });
});

test("a redeclare with a changed schema keeps listeners, re-validates the values and announces added and removed keys", () => {
  const d = dir({ subagents: { maxConcurrent: 20, mode: "slow" } });
  const rig = createRigSettings(d);
  const old = rig.declare("subagents", DECL);
  const heard = [];
  old.onChange((k, v) => heard.push([k, v]));
  rig.notifyWarnings({ notify: () => {} });
  const tighter = [
    { key: "maxConcurrent", type: "integer", min: 1, max: 8, default: 2, description: "Parallel subagents" },
    { key: "mode", type: "enum", values: ["fast", "slow"], default: "fast", description: "Mode" },
    { key: "depth", type: "integer", min: 1, max: 3, default: 1, description: "Depth" },
  ];
  rig.declare("subagents", tighter);
  const warnings = [];
  rig.notifyWarnings({ notify: (m) => warnings.push(m) });
  assert.equal(old.settings, tighter);
  assert.deepEqual(old.values(), { maxConcurrent: 2, mode: "slow", depth: 1 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /subagents\.maxConcurrent must be between 1 and 8; using default 2/);
  assert.deepEqual(heard, [["maxConcurrent", 2], ["depth", 1], ["verbose", undefined]]);
  assert.throws(() => old.get("verbose"), /unknown rig setting/);
  old.set("depth", 3);
  assert.deepEqual(heard.at(-1), ["depth", 3]);
  assert.throws(() => old.set("maxConcurrent", 9), /between 1 and 8/);
});

test("a redeclare warns about an invalid value once, and again only when the value changes", () => {
  const d = dir({ subagents: { maxConcurrent: 99 } });
  const rig = createRigSettings(d);
  const warnings = [];
  const declare = () => {
    rig.declare("subagents", DECL);
    rig.notifyWarnings({ notify: (m) => warnings.push(m) });
  };
  declare();
  declare();
  declare();
  assert.equal(warnings.length, 1);
  writeFileSync(join(d, "rig.json"), JSON.stringify({ subagents: { maxConcurrent: 50 } }));
  declare();
  declare();
  assert.equal(warnings.length, 2);
  writeFileSync(join(d, "rig.json"), JSON.stringify({ subagents: { maxConcurrent: 4 } }));
  declare();
  writeFileSync(join(d, "rig.json"), JSON.stringify({ subagents: { maxConcurrent: 50 } }));
  declare();
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((m) => /subagents\.maxConcurrent must be between 1 and 32/.test(m)));
});

test("a redeclare that cannot read the file keeps the current values and warns once", () => {
  const d = dir();
  const rig = createRigSettings(d);
  const section = rig.declare("subagents", DECL);
  section.set("maxConcurrent", 4);
  const heard = [];
  section.onChange((k, v) => heard.push([k, v]));
  writeFileSync(join(d, "rig.json"), "{ broken");
  const warnings = [];
  for (let i = 0; i < 3; i++) {
    rig.declare("subagents", DECL);
    rig.notifyWarnings({ notify: (m) => warnings.push(m) });
  }
  assert.equal(section.get("maxConcurrent"), 4);
  assert.deepEqual(heard, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rig\.json is not valid JSON.*; keeping current values/);
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

test("setMany validates every key before writing, then writes them in one file update", () => {
  const d = dir();
  const { section } = load(d);
  const heard = [];
  section.onChange((k, v) => heard.push([k, v]));
  assert.throws(() => section.setMany({ verbose: true, maxConcurrent: 99 }), /maxConcurrent must be between 1 and 32/);
  assert.equal(existsSync(join(d, "rig.json")), false);
  assert.equal(section.get("verbose"), false);
  section.setMany({ verbose: true, mode: "slow", maxConcurrent: 10 });
  assert.deepEqual(readFile(d), { subagents: { verbose: true, mode: "slow" } });
  assert.deepEqual(heard, [["verbose", true], ["mode", "slow"], ["maxConcurrent", 10]]);
});
