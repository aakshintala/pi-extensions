import { test } from "node:test";
import assert from "node:assert";
import { gate, parseSkillsFromPrompt, report, sourceLabel } from "../audit/checks.mjs";

const ok = { timedOut: false, shutdownObserved: true };
// gate with budgets.commands matching the snapshot, for tests of the other checks.
const g = (s, b) => gate(s, ok, { commands: (s.commands ?? []).map((c) => c.name), ...b });
const snap = (extra = {}) => ({
  activeTools: ["t"],
  allTools: [{ name: "t", description: "x".repeat(40), sourceInfo: { path: "<builtin:t>" } }, { name: "inactive", description: "x".repeat(4000) }],
  commands: ["rig", "usage", "context", "clear", "theme"].map((name) => ({ name })),
  systemPrompt: "y".repeat(400),
  ...extra,
});

test("report counts system prompt plus active tools only", () => {
  const r = report(snap());
  assert.equal(r.systemPromptTokens, 100);
  assert.equal(r.toolTokens, 11); // 40 chars + "{}"
  assert.equal(r.totalTokens, 111);
});

test("gate passes a clean run and names each failure", () => {
  assert.deepEqual(g(snap(), { maxPromptTokens: 200 }), []);
  const fails = gate(
    snap({ commands: undefined, models: [{ provider: "p", id: "m" }, { provider: "p", id: "m" }] }),
    { timedOut: true, shutdownObserved: false },
    { maxPromptTokens: 50 },
  );
  assert.equal(fails.length, 5);
  assert.match(fails.join("\n"), /missing commands[\s\S]*timed out[\s\S]*shutdown[\s\S]*budget exceeded[\s\S]*p\/m/);
});

test("skills parse from the prompt block", () => {
  const p = "<available_skills><skill>\n<name>a</name></skill><skill><name>b</name></skill></available_skills>";
  assert.deepEqual(parseSkillsFromPrompt(p), ["a", "b"]);
  assert.deepEqual(parseSkillsFromPrompt("none"), []);
});

test("source labels", () => {
  assert.equal(sourceLabel("<builtin:read>"), "builtin");
  assert.equal(sourceLabel("/h/.pi/agent/npm/node_modules/@ff-labs/pi-fff/src/index.ts"), "@ff-labs/pi-fff");
  assert.equal(sourceLabel("/h/.pi/agent/local/pi-stamp/index.ts"), "pi-stamp");
});

test("gate enforces per-tool budgets for non-builtin tools", () => {
  const rig = { name: "rig_tool", description: "x".repeat(40), sourceInfo: { path: "/repo/extensions/a/index.ts" } };
  const s = snap({ activeTools: ["rig_tool"], allTools: [rig] });
  assert.deepEqual(g(s, { maxPromptTokens: 200, tools: { rig_tool: 11 } }), []);
  assert.match(g(s, { maxPromptTokens: 200, tools: { rig_tool: 10 } }).join(), /rig_tool over budget: 11 > 10/);
  assert.match(g(s, { maxPromptTokens: 200 }).join(), /rig_tool has no budget/);
  assert.match(g(snap(), { maxPromptTokens: 200, tools: { gone: 5 } }).join(), /budgeted tool gone is not active/);
});

test("a budget on a builtin tool is enforced", () => {
  assert.match(g(snap(), { maxPromptTokens: 200, tools: { t: 1 } }).join(), /tool t over budget/);
});

test("gate requires /rig and refuses /agents, /tasks and /bg* commands", () => {
  const ports = ["usage", "context", "clear", "theme"];
  const names = (...n) => snap({ commands: [...n, ...ports].map((name) => ({ name })) });
  assert.deepEqual(g(names("rig", "other"), { maxPromptTokens: 200 }), []);
  assert.deepEqual(g(names("other"), { maxPromptTokens: 200 }), ["/rig is not registered"]);
  assert.deepEqual(g(names("rig", "agents", "tasks", "bg-list", "agents-report", "tasks-help"), { maxPromptTokens: 200 }), [
    "/agents is registered; settings belong in /rig",
    "/tasks is registered; settings belong in /rig",
    "/bg-list is registered; settings belong in /rig",
  ]);
});

test("gate requires /usage, /context, /clear and /theme and refuses a /context config command", () => {
  const names = (...n) => snap({ commands: n.map((name) => ({ name })) });
  assert.deepEqual(g(names("rig", "usage", "context", "clear", "theme"), { maxPromptTokens: 200 }), []);
  assert.deepEqual(g(names("rig", "usage"), { maxPromptTokens: 200 }), [
    "/context is not registered",
    "/clear is not registered",
    "/theme is not registered",
  ]);
  assert.deepEqual(g(names("rig", "usage", "context", "clear", "theme", "context-config"), { maxPromptTokens: 200 }), [
    "/context-config is registered; /context has no config",
  ]);
});

test("gate pins the rig's own command names to budgets.commands, exactly and failing closed", () => {
  const cmds = [
    { name: "rig", path: "/repo/extensions/rig/index.ts" },
    { name: "llama", path: "<inline:llama.cpp>" }, // Pi's own: not pinned
    { name: "a b", path: "/repo/extensions/x/index.ts" },
  ];
  const s = snap({ commands: cmds.concat(["usage", "context", "clear", "theme"].map((name) => ({ name }))) });
  const expected = ["rig", "a b", "usage", "context", "clear", "theme"];
  assert.deepEqual(gate(s, ok, { maxPromptTokens: 200, commands: expected }), []);
  assert.deepEqual(gate(s, ok, { maxPromptTokens: 200 }), ["budgets.json has no commands list"]);
  assert.match(gate(s, ok, { maxPromptTokens: 200, commands: [...expected, "llama"] }).join(), /^commands are \[.*\], budgets.json expects/);
  // "a b" is one name, not two: a space-joined comparison would accept this.
  assert.equal(gate(s, ok, { maxPromptTokens: 200, commands: [...expected.slice(0, 1), "a", "b", ...expected.slice(2)] }).length, 1);
});
