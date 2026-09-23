import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
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

test("persist saves the turn to a .jsonl on disk", async (t) => {
  const { session, agentDir } = await scriptedSession(t, { replies: [fauxAssistantMessage(fauxText("saved"))], persist: true });
  await session.prompt("keep this");

  const file = session.sessionManager.getSessionFile();
  assert.ok(file.startsWith(join(agentDir, "..", "sessions") + "/"), file);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const said = lines.filter((e) => e.type === "message" && e.message.role !== "system").map(({ message: m }) => [m.role, m.content[0]?.text ?? m.content]);
  assert.deepEqual(said, [["user", "keep this"], ["assistant", "saved"]]);
});

// #88: Pi's model runtimes refresh after dispose, and a file-backed one recreates
// agent/auth.json and agent/models-store.json. After each dispose and rm, run the runtime's
// refresh again (the same work the late refresh does) and check the box stays gone.
// Odd runs add a child on the shared runtime in the same agentDir.
test("nothing is recreated in the box after dispose and cleanup", async (t) => {
  for (let i = 0; i < 10; i++) {
    let runtime, box;
    await t.test(`run ${i}`, async (st) => {
      const { session, cwd, agentDir } = await scriptedSession(st);
      ({ modelRuntime: runtime } = session);
      box = join(agentDir, "..");
      if (i % 2) {
        const child = await createAgentSession({ cwd, agentDir, model: session.model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd) });
        child.session.dispose();
      }
    });
    assert.equal(existsSync(box), false);
    await runtime.refresh({ allowNetwork: false });
    const left = existsSync(box);
    rmSync(box, { recursive: true, force: true });
    assert.equal(left, false, `run ${i} recreated ${box}`);
  }
});
