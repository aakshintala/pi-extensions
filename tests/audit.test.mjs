import { test } from "node:test";
import assert from "node:assert";
import { gate, parseSkillsFromPrompt, report, sourceLabel } from "../audit/checks.mjs";

const ok = { timedOut: false, shutdownObserved: true };
const snap = (extra = {}) => ({
  activeTools: ["t"],
  allTools: [{ name: "t", description: "x".repeat(40) }, { name: "inactive", description: "x".repeat(4000) }],
  commands: [],
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
  assert.deepEqual(gate(snap(), ok, { maxPromptTokens: 200 }), []);
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
