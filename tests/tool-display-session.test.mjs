// Tool display (#55) in a scripted session: the rig's read keeps Pi's execution,
// renders in the shared style, and replaces the built-in once, also after /reload.
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
    return c.render(80).map(plain).filter(Boolean);
  };
  const names = () => session.getAllTools().map((t) => t.name).filter((n) => ["read", "edit", "write", "ls"].includes(n)).sort();
  for (const when of ["start", "after reload"]) {
    assert.deepEqual(render(), [" ⏺ Read(a.txt)", "   ⎿  Read 2 lines"], when);
    assert.deepEqual(names(), ["edit", "ls", "read", "write"], when);
    if (when === "start") await session.reload();
  }
});
