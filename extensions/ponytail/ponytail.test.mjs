import { test } from "node:test";
import assert from "node:assert/strict";
import ponytail, { PONYTAIL } from "./index.ts";

function handlerFor() {
  const handlers = {};
  ponytail({ on: (name, fn) => (handlers[name] = fn) });
  assert.deepEqual(Object.keys(handlers), ["before_agent_start"]);
  return handlers.before_agent_start;
}

const event = () => ({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: { other: "x" } } });

test("section text fits 200 tokens by char/4", () => {
  assert.ok(Math.ceil(PONYTAIL.length / 4) <= 200, `${Math.ceil(PONYTAIL.length / 4)} tokens`);
});

test("adds exactly one section and returns no systemPrompt, idempotently", () => {
  const run = handlerFor();
  const e = event();
  for (let i = 0; i < 2; i++) {
    assert.equal(run(e)?.systemPrompt, undefined);
    assert.deepEqual(e.systemPromptOptions.sections, { other: "x", ponytail: PONYTAIL });
  }
  assert.equal(e.systemPromptOptions.forceSystemPrompt, undefined);
});

test("creates sections when an earlier handler left none", () => {
  const e = { type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: {} };
  assert.equal(handlerFor()(e)?.systemPrompt, undefined);
  assert.deepEqual(e.systemPromptOptions.sections, { ponytail: PONYTAIL });
});
