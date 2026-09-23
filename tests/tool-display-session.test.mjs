// Tool display (#55, #56) in a scripted session: the rig's read keeps Pi's execution,
// renders in the shared style, and replaces the built-in once, also after /reload;
// a saved transcript groups the same way as the live session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "./fixtures/tool-display/pi-tui.mjs";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

const { default: toolDisplay } = await import("../extensions/tool-display/index.ts");
const plain = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

test("read runs as Pi's read, renders in the shared style, and is registered once", async (t) => {
  initTheme("dark", false);
  const { session, cwd } = await scriptedSession(t, {
    replies: [fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
    extensions: [toolDisplay],
    tools: ["read", "edit", "write", "ls"],
  });
  writeFileSync(join(cwd, "a.txt"), "one\ntwo");
  await session.prompt("read a.txt");
  const call = session.messages.find((m) => m.role === "assistant").content[0];
  const result = session.messages.find((m) => m.role === "toolResult");
  assert.deepEqual([result.isError, result.content[0].text], [false, "one\ntwo"]);

  const render = () => {
    const c = new ToolExecutionComponent("read", call.id, call.arguments, {}, session.getToolDefinition("read"), { requestRender() {} }, cwd);
    c.updateResult({ content: result.content, details: result.details, isError: result.isError });
    c.setExpanded(true); // collapsed, a lone call is a one-line group summary
    return c.render(80).map(plain).filter(Boolean);
  };
  const names = () => session.getAllTools().map((t) => t.name).filter((n) => ["read", "edit", "write"].includes(n)).sort();
  for (const when of ["start", "after reload"]) {
    assert.deepEqual(render(), [" ⏺ Read(a.txt)", "   ⎿  Read 2 lines", "      one", "      two"], when);
    assert.deepEqual(names(), ["edit", "read", "write"], when);
    if (when === "start") await session.reload();
  }
});

test("the rig adds no active tools to Pi's defaults", async (t) => {
  const { session } = await scriptedSession(t, { extensions: [toolDisplay] });
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]);
});

test("a saved transcript groups the same way as the live session", async (t) => {
  initTheme("dark", false);
  const read = (path) => fauxToolCall("read", { path });
  const { session, cwd } = await scriptedSession(t, {
    replies: [
      fauxAssistantMessage([read("a.txt"), read("missing.txt"), fauxText("and"), read("a.txt"), fauxToolCall("ls", {}), read("a.txt")], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("ok")),
    ],
    extensions: [toolDisplay],
    tools: ["read", "ls"],
  });
  writeFileSync(join(cwd, "a.txt"), "one\ntwo");
  await session.prompt("go");
  const results = new Map(session.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const calls = session.messages.find((m) => m.role === "assistant").content.filter((b) => b.type === "toolCall");
  // Pi's chat builds one component per call, in order, and gives it the saved result.
  const transcript = () =>
    calls.flatMap((b) => {
      const c = new ToolExecutionComponent(b.name, b.id, b.arguments, {}, session.getToolDefinition(b.name), { requestRender() {} }, cwd);
      const r = results.get(b.id);
      c.updateResult({ content: r.content, details: r.details, isError: r.isError });
      return c.render(80).map(plain);
    });

  const live = transcript();
  assert.deepEqual(live.slice(0, 5), ["", " ⏺ Read 1 file · 1 failed", "", " ⏺ Read(missing.txt)", `   ⎿  Error: ENOENT: no such file or directory, access 'missing.txt'`]);
  assert.deepEqual(live.slice(5, 7), ["", " ⏺ Read 1 file"]);
  assert.deepEqual(live.slice(-2), ["", " ⏺ Read 1 file"]); // ls, not grouped, splits the run
  // As on /resume: groups are forgotten, then registered again from the saved branch.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
  assert.equal(transcript()[1], " ⏺ Read(a.txt)");
  await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  assert.deepEqual(transcript(), live);
});
