import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("persist saves the turn to a .jsonl on disk", async (t) => {
  const { session } = await scriptedSession(t, { replies: [fauxAssistantMessage(fauxText("saved"))], persist: true });
  await session.prompt("keep this");

  const lines = readFileSync(session.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const said = lines.filter((e) => e.type === "message" && e.message.role !== "system").map(({ message: m }) => [m.role, m.content[0]?.text ?? m.content]);
  assert.deepEqual(said, [["user", "keep this"], ["assistant", "saved"]]);
});

// Pi's model runtimes write agent/auth.json and agent/models-store.json after dispose (#88):
// the helper's own, and a child session's built in the same agentDir. Run dispose then
// cleanup many times in a fresh process, half with a child, then check no box survives
// its exit. An immediate dispose races the helper runtime's own refresh.
test("no session box is left behind once the process exits", () => {
  const helper = pathToFileURL(join(import.meta.dirname, "helpers/session.mjs")).href;
  const script = `
    import { test } from "node:test";
    import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
    import { scriptedSession } from ${JSON.stringify(helper)};
    for (let i = 0; i < 10; i++) test("run " + i, async (t) => {
      const { session, cwd, agentDir } = await scriptedSession(t);
      console.log("BOX " + join(agentDir, ".."));
      if (i % 2) {
        const child = await createAgentSession({ cwd, agentDir, model: session.model, sessionManager: SessionManager.inMemory(cwd) });
        child.session.dispose();
      }
    });
    import { join } from "node:path";`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: import.meta.dirname, env, encoding: "utf8" });
  const boxes = out.split("\n").filter((l) => l.startsWith("BOX ")).map((l) => l.slice(4));
  assert.equal(boxes.length, 10);
  const left = boxes.filter(existsSync);
  for (const box of left) rmSync(box, { recursive: true });
  assert.deepEqual(left, []);
});
