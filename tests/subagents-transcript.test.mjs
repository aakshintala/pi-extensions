// The agent transcript (#68) drawn from a SessionManager, without a live session: the
// first open is bounded, later syncs append (a compaction too), custom messages are plain text, calls group
// with the rig definitions of their own tree only, and closing releases the groups.
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

/** The tool definitions of one tree of agents. */
const tree = new Map();

/** An agent with no live session, as after its session closed, in `defs`' tree. */
function agent(defs = tree) {
  const manager = SessionManager.inMemory("/w");
  return { manager, cwd: "/w", partial: new Map(), version: 0, root: { defs } };
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

test("a compaction keeps the messages drawn before it, and its summary is not drawn", () => {
  const a = agent();
  a.manager.appendMessage(user("before"));
  const kept = a.manager.appendMessage(user("kept"));
  const view = transcript(a, tui, ui);
  assert.deepEqual(plain(view.render(60)), [" before", " kept"]);
  a.manager.appendCompaction("the summary", kept, 100);
  a.manager.appendMessage(user("after"));
  a.version++;
  assert.deepEqual(plain(view.render(60)), [" before", " kept", " after"]);
});

// The rig's read renderer, as another child session of the tree registered it.
rememberTools({ getAllTools: () => [{ name: "read" }], getToolDefinition: () => ({ ...createReadToolDefinition("/w"), ...RENDERERS.read }) }, tree);

test("with no session of its own, calls group with the rig definitions other child sessions registered", () => {
  const a = agent();
  a.manager.appendMessage(said([read("t1", "a.md"), read("t2", "b.md")]));
  a.manager.appendMessage(result("t1", "one"));
  a.manager.appendMessage(result("t2", "two"));
  const view = transcript(a, tui, ui);
  assert.deepEqual(plain(view.render(60)), [" ⏺ Read 2 files"]);
  view.dispose();
});

test("an agent of another tree does not use this tree's definitions", () => {
  const a = agent(new Map());
  a.manager.appendMessage(said([read("o1", "a.md"), read("o2", "b.md")]));
  a.manager.appendMessage(result("o1", "one"));
  a.manager.appendMessage(result("o2", "two"));
  const view = transcript(a, tui, ui);
  // Pi's stock read tool: one line per call, no group.
  const lines = plain(view.render(60));
  assert.ok(!lines.some((l) => l.includes("Read 2 files")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("a.md")) && lines.some((l) => l.includes("b.md")), lines.join("\n"));
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

test("a saved run of tool-only responses is one group until the next prompt, as in the main chat (#133)", () => {
  const a = agent();
  const steps = [said([read("s1", "a.md")]), result("s1", "one"), said([read("s2", "b.md")]), result("s2", "two"), user("next"), said([read("s3", "c.md")]), result("s3", "three")];
  for (const m of steps) a.manager.appendMessage(m);
  const view = transcript(a, tui, ui);
  assert.deepEqual(plain(view.render(60)), [" ⏺ Read 2 files", " next", " ⏺ Read 1 file"]);
  view.dispose();
});
