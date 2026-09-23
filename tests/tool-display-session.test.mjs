// Tool display (#55) across session replacement: the decoration is removed on
// every shutdown, installed once by the next session's extension instance, and
// gone after pi quits. Checked by rendering the read call's component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "./fixtures/tool-display/pi-tui.mjs";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

const { default: toolDisplay } = await import("../extensions/tool-display/index.ts");
const plain = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const DECORATED = [" ⏺ Read(a.txt)", "   ⎿  Read 2 lines"];
const PI_DEFAULT = [" read a.txt"];

test("decoration is cleared on shutdown and installed once per session", async (t) => {
  initTheme("dark", false);
  let render = () => [];
  const atShutdown = [];
  const { session, cwd } = await scriptedSession(t, {
    replies: [fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
    // Loaded after tool-display, so its handler sees what tool-display left at shutdown.
    extensions: [toolDisplay, (pi) => pi.on("session_shutdown", (e) => atShutdown.push([e.reason, render()]))],
    tools: ["read", "edit", "write", "ls"],
  });
  // Registered after the helper's hook, so it runs once pi has quit.
  t.after(() => {
    assert.deepEqual(atShutdown, [["reload", PI_DEFAULT], ["quit", PI_DEFAULT]]);
    assert.deepEqual(render(), PI_DEFAULT);
  });

  writeFileSync(join(cwd, "a.txt"), "one\ntwo");
  await session.prompt("read a.txt");
  const definition = session.getToolDefinition("read");
  const call = session.messages.find((m) => m.role === "assistant").content[0];
  const result = session.messages.find((m) => m.role === "toolResult");
  render = () => {
    const c = new ToolExecutionComponent("read", call.id, call.arguments, {}, definition, { requestRender() {} }, cwd);
    c.updateResult({ content: result.content, details: result.details, isError: result.isError });
    return c.render(80).map(plain).filter(Boolean);
  };
  assert.deepEqual(render(), PI_DEFAULT); // no decoration before session_start

  await session.bindExtensions({ onError: (e) => assert.fail(e.error) }); // session_start
  assert.deepEqual(render(), DECORATED);
  await session.reload(); // shutdown, then a new extension instance starts
  assert.deepEqual(render(), DECORATED);
});
