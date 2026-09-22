// Budget tests for the runtime audit: every check in audit/checks.mjs is
// exercised against the committed baseline (must pass) and against fixtures
// (must fail, except intercom which is informational in both states).
// No pi binary, no network, no credentials needed.
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  runAll,
  checkTools,
  checkCommands,
  checkPromptBudget,
  checkDuplicates,
  checkIntercom,
  checkUpstream,
  estimatePromptTokens,
} from "../audit/checks.mjs";

const dir = new URL("../audit/", import.meta.url);
const baseline = JSON.parse(readFileSync(new URL("baseline.json", dir), "utf8"));
const budgets = JSON.parse(readFileSync(new URL("budgets.json", dir), "utf8"));
const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const live = { ...baseline, piVersion: budgets.piVersion };

describe("audit budgets on committed baseline", () => {
  it("active-tool snapshot matches", () => {
    assert.doesNotThrow(() => checkTools(live, baseline));
  });
  it("prompt tokens within ceiling", () => {
    const tokens = estimatePromptTokens(live);
    assert.ok(tokens > 0, "estimate must be non-trivial");
    assert.doesNotThrow(() => checkPromptBudget(live, budgets));
  });
  it("no unexpected commands", () => {
    assert.doesNotThrow(() => checkCommands(live, baseline));
  });
  it("no duplicate provider-model pairs", () => {
    assert.doesNotThrow(() => checkDuplicates(live));
  });
  it("intercom passes whether on or off", () => {
    assert.match(checkIntercom({ activeTools: ["read", "intercom"] }), /on/);
    assert.match(checkIntercom({ activeTools: ["read"] }), /off/);
  });
  it("no upstream path loaded as a Pi resource", () => {
    assert.doesNotThrow(() => checkUpstream(live, REPO_ROOT));
  });
  it("runAll reports zero failures", () => {
    const { failures } = runAll(live, baseline, budgets, REPO_ROOT);
    assert.deepEqual(failures, []);
  });
});

describe("audit budget violations fail", () => {
  it("changed active tools fail", () => {
    assert.throws(() => checkTools({ ...live, activeTools: ["read"] }, baseline), /active tools changed/);
  });
  it("unknown tool fails", () => {
    const t = { ...live, allTools: [...live.allTools, { name: "evil", sourceInfo: { path: "x" } }] };
    assert.throws(() => checkTools(t, baseline), /unknown tools/);
  });
  it("unexpected command fails", () => {
    const c = { ...live, commands: [...live.commands, { name: "evil-cmd", source: "extension" }] };
    assert.throws(() => checkCommands(c, baseline), /added \[evil-cmd\]/);
  });
  it("removed command fails", () => {
    assert.throws(() => checkCommands({ ...live, commands: [] }, baseline), /removed/);
  });
  it("prompt over ceiling fails", () => {
    const big = { ...live, systemPrompt: "x".repeat(budgets.maxPromptTokens * 4 + 1) };
    assert.throws(() => checkPromptBudget(big, budgets), /budget exceeded/);
  });
  it("duplicate provider-model pairs fail", () => {
    const d = { models: [{ provider: "p", id: "m" }, { provider: "p", id: "m" }] };
    assert.throws(() => checkDuplicates(d), /duplicate provider-model/);
  });
  it("upstream path loaded fails", () => {
    const u = {
      ...live,
      commands: [...live.commands, { name: "x", sourceInfo: { path: `${REPO_ROOT}/upstream/evil/index.ts` } }],
    };
    assert.throws(() => checkUpstream(u, REPO_ROOT), /upstream paths/);
  });
});
