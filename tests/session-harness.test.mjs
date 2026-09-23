import { test } from "node:test";
import assert from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

test("scripted session runs one turn with a tool call", async (t) => {
  let shutdown;
  const { session, cwd, home, agentDir } = await scriptedSession(t, {
    replies: [
      fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(fauxText(`file says: ${context.messages.at(-1).content[0].text}`)),
    ],
    extensions: [(pi) => pi.on("session_shutdown", (e) => (shutdown = { reason: e.reason, cwdExists: existsSync(cwd) }))],
  });
  // Registered after the helper's hook, so it runs after cleanup: shutdown fired
  // like pi's quit, while the temp dirs still existed.
  t.after(() => assert.deepEqual(shutdown, { reason: "quit", cwdExists: true }));

  assert.equal(homedir(), home);
  assert.equal(getAgentDir(), agentDir);
  assert.equal(process.env.PI_OFFLINE, "1");

  writeFileSync(join(cwd, "hello.txt"), "hi from disk");
  await session.prompt("read hello.txt");

  const result = session.messages.find((m) => m.role === "toolResult");
  assert.equal(result.toolName, "read");
  assert.equal(result.isError, false);
  assert.equal(session.getLastAssistantText(), "file says: hi from disk");
});
