import { test } from "node:test";
import assert from "node:assert/strict";
import "../../tests/fixtures/tool-display/pi-tui.mjs";

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
    const ctx = { sessionManager: { getBranch: () => [] } };
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
  assert.deepEqual(["p1", "p2"].flatMap((id) => draw(id).render(80)), [" ⠋ Read 2 files"]);
  parent("session_shutdown");
});
