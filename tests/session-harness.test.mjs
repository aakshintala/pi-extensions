import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

test("scripted session runs one turn with a tool call", async (t) => {
  const { session, cwd } = await scriptedSession(t, {
    replies: [
      fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(fauxText(`file says: ${context.messages.at(-1).content[0].text}`)),
    ],
  });
  writeFileSync(join(cwd, "hello.txt"), "hi from disk");

  await session.prompt("read hello.txt");

  const result = session.messages.find((m) => m.role === "toolResult");
  assert.equal(result.toolName, "read");
  assert.equal(result.isError, false);
  assert.equal(session.getLastAssistantText(), "file says: hi from disk");
});
