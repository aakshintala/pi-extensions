// End-to-end fixture: drives the real audit probe (audit/probe.ts) with a
// system prompt containing a genuine <available_skills> block and asserts
// the snapshot captures the skill. Proves capture against >=1 skill, which
// the committed baseline ([] vs []) cannot.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import probe from "../audit/probe.ts";
import { checkSkills } from "../audit/checks.mjs";

const budgets = JSON.parse(readFileSync(new URL("../audit/budgets.json", import.meta.url), "utf8"));

// Shape mirrors formatSkillsForPrompt output in pi 0.87.1.
const SKILL_BLOCK = [
  "<available_skills>",
  "  <skill>",
  "    <name>triage</name>",
  "    <description>Move issues through triage states</description>",
  "    <location>/skills/triage/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

const EXPECTED = [
  {
    name: "triage",
    description: "Move issues through triage states",
    location: "/skills/triage/SKILL.md",
  },
];

async function capture(systemPrompt) {
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
      return () => {};
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
  };
  const ctx = {
    modelRegistry: { getAvailable: () => [] },
    getSystemPrompt: () => systemPrompt,
  };
  probe(pi);
  const dir = mkdtempSync(join(tmpdir(), "skills-probe-"));
  const snapPath = join(dir, "snapshot.json");
  const prev = process.env.PI_AUDIT_SNAP;
  process.env.PI_AUDIT_SNAP = snapPath;
  try {
    await handlers.session_start({}, ctx);
    return JSON.parse(readFileSync(snapPath, "utf8"));
  } finally {
    if (prev === undefined) delete process.env.PI_AUDIT_SNAP;
    else process.env.PI_AUDIT_SNAP = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("probe skills capture end to end", () => {
  it("captures a real skill from the prompt block", async () => {
    const snap = await capture(`You are pi.\n\n${SKILL_BLOCK}\n`);
    assert.deepEqual(snap.skills, EXPECTED);
  });
  it("captured skill passes the budget check against a matching baseline", async () => {
    const snap = await capture(`You are pi.\n\n${SKILL_BLOCK}\n`);
    assert.doesNotThrow(() => checkSkills(snap, { skills: EXPECTED }, budgets));
    assert.throws(() => checkSkills(snap, { skills: [] }, budgets), /added \[triage\]/);
  });
  it("empty prompt block captures no skills", async () => {
    const snap = await capture("You are pi, no skills here.");
    assert.deepEqual(snap.skills, []);
  });
});
