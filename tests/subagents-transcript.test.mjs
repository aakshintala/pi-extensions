// The agent transcript (#68) drawn from a SessionManager, without a live session: the
// first open is bounded, later syncs append, custom messages are plain text, calls group
// with the rig's definitions from other child sessions, and closing releases the groups.
import "./fixtures/tool-display/pi-tui.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createReadToolDefinition, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";

const THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");
const before = globalThis[THEME];
initTheme("dark", false);
const theme = globalThis[THEME];
after(() => (globalThis[THEME] = before));

const { OPEN_MESSAGES, rememberTools, transcript } = await import("../extensions/subagents/transcript.ts");
const { RENDERERS } = await import("../extensions/tool-display/index.ts");

const plain = (lines) => lines.map((l) => l.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(Boolean);
const tui = { requestRender() {} };
const ui = { getToolsExpanded: () => false, theme };
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const said = (content) => ({ role: "assistant", content, stopReason: "toolUse", api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 });
const read = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 });

/** An agent with no live session, as after its session closed. */
function agent() {
  const manager = SessionManager.inMemory("/w");
  return { manager, cwd: "/w", partial: new Map(), version: 0 };
}

test("the first open draws the last messages and counts the rest; later messages are appended", () => {
  const a = agent();
  for (let i = 0; i < OPEN_MESSAGES + 3; i++) a.manager.appendMessage(user(`m${i}`));
  const view = transcript(a, tui, ui);
  const first = plain(view.render(60));
  assert.deepEqual(first.slice(0, 2), [" … 3 earlier messages", " m3"]);
  assert.equal(first.at(-1), ` m${OPEN_MESSAGES + 2}`);
  a.manager.appendMessage(user("late"));
  a.version++;
  assert.deepEqual(plain(view.render(60)), [...first, " late"]);
});

test("a custom message is drawn as plain text, its control sequences removed", () => {
  const a = agent();
  a.manager.appendCustomMessageEntry("rig.notice", "done\x1b]0;owned\x07 \x1b[2Jnow\nnext", true);
  assert.deepEqual(plain(transcript(a, tui, ui).render(60)), [" done now", " next"]);
});

// The rig's read renderer, as another child session registered it.
rememberTools({ getAllTools: () => [{ name: "read" }], getToolDefinition: () => ({ ...createReadToolDefinition("/w"), ...RENDERERS.read }) });

test("with no session of its own, calls group with the rig definitions other child sessions registered", () => {
  const a = agent();
  a.manager.appendMessage(said([read("t1", "a.md"), read("t2", "b.md")]));
  a.manager.appendMessage(result("t1", "one"));
  a.manager.appendMessage(result("t2", "two"));
  const view = transcript(a, tui, ui);
  assert.deepEqual(plain(view.render(60)), [" ⏺ Read 2 files"]);
  view.dispose();
});

test("a closed transcript leaves no calls behind to group another session's call with the same id", () => {
  const a = agent();
  a.manager.appendMessage(said([read("k1", "a.md")]));
  a.manager.appendMessage(result("k1", "one"));
  const view = transcript(a, tui, ui);
  assert.deepEqual(plain(view.render(60)), [" ⏺ Read 1 file"]);
  view.dispose();
  // The main chat's call k1, which no groups of its own track: drawn as a plain call.
  const args = { path: "mine.md" };
  const context = { toolCallId: "k1", args, cwd: "/w", expanded: false, isPartial: false, isError: false, invalidate() {} };
  assert.deepEqual(plain(RENDERERS.read.renderCall(args, theme, context).render(60)), [" ⏺ Read(mine.md)"]);
});
