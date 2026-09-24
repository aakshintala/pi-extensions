import { test } from "node:test";
import assert from "node:assert/strict";
import "../../tests/fixtures/tool-display/pi-tui.mjs";

const { ToolGroups } = await import("../../shared/tool-display/index.ts");
// These sessions draw pending calls; the grace period has its own tests.
ToolGroups.defaultGraceMs = 0;

const { RENDERERS } = await import("./index.ts");
const theme = { fg: (_k, t) => t, bold: (t) => t };
const ctx = (args) => ({ args, cwd: "/w", isPartial: false, isError: false, expanded: false });
const done = { expanded: false, isPartial: false };

test("edit arguments of an unexpected shape fall back to the result text", () => {
  const result = { content: [{ type: "text", text: "Successfully replaced 1 block(s) in b.txt." }] };
  const lines = RENDERERS.edit.renderResult(result, done, theme, ctx({ path: "b.txt", edits: "not an array" })).render(80);
  assert.deepEqual(lines, ["   ⎿  Successfully replaced 1 block(s) in b.txt."]);
});

// Two sessions in one process, as with an in-process subagent: each extension instance
// keeps its own groups, so the child's lifecycle leaves the parent's alone.
test("a child session's start, agent_end and shutdown leave the parent's groups intact", async () => {
  const { default: toolDisplay } = await import("./index.ts");
  const session = () => {
    const on = {};
    toolDisplay({ registerTool() {}, on: (name, f) => (on[name] = f) });
    const ctx = { sessionManager: { buildContextEntries: () => [], getSessionId: () => "s" } };
    return (name, event = {}) => on[name]?.(event, ctx);
  };
  const read = (id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } });
  const parent = session();
  parent("session_start");
  parent("message_end", { message: { role: "assistant", content: [read("p1"), read("p2")] } });
  parent("tool_execution_end", { toolCallId: "p1", isError: false, result: { content: [] } });

  const child = session();
  child("session_start");
  child("message_end", { message: { role: "assistant", content: [read("k1")] } });
  child("agent_end");
  child("session_shutdown");

  const draw = (id) => RENDERERS.read.renderCall({ path: id }, theme, { ...ctx({ path: id }), toolCallId: id, invalidate() {} });
  ["p1", "p2"].forEach(draw);
  assert.deepEqual(["p1", "p2"].flatMap((id) => draw(id).render(80)), [" ⏺ Read 2 files"]);
  parent("session_shutdown");
});

// Some providers make ids from the clock (Gemini: `name_${Date.now()}_n`), so two
// in-process sessions can share one. Each keeps its own; the child's shutdown
// leaves the parent's untouched.
test("sessions that share a call id keep their own groups", async () => {
  const { default: toolDisplay } = await import("./index.ts");
  const session = () => {
    const on = {};
    toolDisplay({ registerTool() {}, on: (name, f) => (on[name] = f) });
    const ctx = { sessionManager: { buildContextEntries: () => [], getSessionId: () => "s" } };
    return (name, event = {}) => on[name]?.(event, ctx);
  };
  const read = (id, args = { path: id }) => ({ type: "toolCall", id, name: "read", arguments: args });
  const parentCalls = [read("dup"), read("p2")];
  const parent = session();
  parent("session_start");
  parent("message_end", { message: { role: "assistant", content: parentCalls } });

  const child = session();
  child("session_start");
  child("message_end", { message: { role: "assistant", content: [read("dup")] } });
  child("tool_execution_end", { toolCallId: "dup", isError: false, result: { content: [] } });
  const draw = (b) => RENDERERS.read.renderCall(b.arguments, theme, { ...ctx(b.arguments), toolCallId: b.id, invalidate() {} });
  parentCalls.forEach(draw);
  assert.deepEqual(parentCalls.flatMap((b) => draw(b).render(80)), [" ⏺ Read 2 files"], "while both run");
  child("session_shutdown");
  assert.deepEqual(parentCalls.flatMap((b) => draw(b).render(80)), [" ⏺ Read 2 files"], "after the child shuts down");
  parent("session_shutdown");
});

// #40: "A call that returned an error before the abort counts as failed." Esc while
// the model is only thinking after a real error must not hide that error.
test("a real error stays failed and folded when Esc comes during a thinking-only reply, live and after reopen", async () => {
  const { default: toolDisplay } = await import("./index.ts");
  const on = {};
  toolDisplay({ registerTool() {}, on: (name, f) => (on[name] = f) });
  const branch = [];
  const piCtx = { sessionManager: { buildContextEntries: () => branch, getSessionId: () => "s" } };
  const emit = (name, event = {}) => on[name]?.(event, piCtx);
  const call = { type: "toolCall", id: "enoent1", name: "read", arguments: { path: "missing.txt" } };
  const failure = { content: [{ type: "text", text: "ENOENT: no such file or directory, access 'missing.txt'" }] };
  const saved = [
    { role: "assistant", stopReason: "toolUse", content: [call] },
    { role: "toolResult", toolCallId: call.id, isError: true, ...failure },
    { role: "assistant", stopReason: "aborted", content: [{ type: "thinking", thinking: "Let me" }] },
  ];
  emit("session_start");
  emit("message_end", { message: saved[0] });
  emit("tool_execution_end", { toolCallId: call.id, isError: true, result: failure });
  emit("message_end", { message: saved[2] });
  emit("agent_end");
  const draw = () => RENDERERS.read.renderCall(call.arguments, theme, { ...ctx(call.arguments), toolCallId: call.id, invalidate() {} }).render(80);
  // The reply with only thinking belongs to the run, so it leads the summary (#133).
  const want = [" ⏺ thought · read 1 file"];
  assert.deepEqual(draw(), want, "live");
  emit("session_shutdown");
  branch.push(...saved.map((message) => ({ type: "message", message })));
  emit("session_start");
  assert.deepEqual(draw(), want, "after reopen");
  emit("session_shutdown");
});
