import { test } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, scriptedSession } from "../../tests/helpers/session.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;

test("the model request carries the ponytail section exactly once, every run", async (t) => {
  const prompts = [];
  const reply = (context) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage(fauxText("ok"));
  };
  const { session } = await scriptedSession(t, { replies: [reply, reply], extensions: [EXT] });
  await session.prompt("one");
  await session.prompt("two");

  assert.equal(prompts.length, 2);
  for (const p of prompts) {
    assert.equal(p.match(/<ponytail>/g)?.length, 1);
    assert.match(p, /<cwd>/); // the rest of the prompt is still there
  }
});
