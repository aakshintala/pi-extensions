// Hidden thinking (#57): with the tool-display extension live, hidden thinking renders
// zero lines and shown thinking gets a restyled label; any other Pi (version or child
// shape) keeps Pi's own render; the patch lives exactly as long as a session using it;
// saved sessions are byte-identical with and without it; groups say "thought ·".
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme, AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

const { default: toolDisplay } = await import("../extensions/tool-display/index.ts");
const { useHiddenThinking, releaseHiddenThinking } = await import("../extensions/tool-display/thinking.ts");
const { Spacer } = await import("@earendil-works/pi-tui");

initTheme("dark", false);
const plain = (s) => s.replace(/\x1b\]133;[A-C]\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const render = (message, hidden) => new AssistantMessageComponent(message, hidden).render(60).map(plain);
const msg = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason });
const think = { type: "thinking", thinking: "Weighing it." };
const text = (t) => ({ type: "text", text: t });
const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } };

const SHAPES = {
  "thinking and a call": [msg([think, call], "toolUse"), msg([call], "toolUse")],
  "thinking then text": [msg([think, text("Answer.")]), msg([text("Answer.")])],
  "text then thinking": [msg([text("Answer."), think]), msg([text("Answer.")])],
  "two thinking runs around a call": [msg([think, call, think], "toolUse"), msg([call], "toolUse")],
  "thinking, then an abort": [msg([think], "aborted"), msg([], "aborted")],
};
const STOCK = Object.fromEntries(Object.entries(SHAPES).map(([k, [m]]) => [k, { hidden: render(m, true), shown: render(m, false) }]));

test("stock Pi draws a hidden-thinking label (the control)", () => {
  assert.deepEqual(STOCK["thinking and a call"].hidden, ["", " Thinking..."]);
});

test("hidden thinking renders zero lines, with and without text; shown thinking gets the label", (t) => {
  const owner = {};
  t.after(() => releaseHiddenThinking(owner));
  assert.equal(useHiddenThinking(owner, "0.87.1"), true);
  for (const [name, [withThinking, without]] of Object.entries(SHAPES)) {
    assert.deepEqual(render(withThinking, true), render(without, true), name);
  }
  assert.deepEqual(render(SHAPES["thinking and a call"][0], true), []);
  assert.deepEqual(render(SHAPES["thinking then text"][0], false), ["", " ✻ Thinking", " Weighing it.", "", " Answer."]);
  // A block the user clicked open (a per-block override) keeps Pi's render.
  const c = new AssistantMessageComponent(SHAPES["thinking then text"][0], true);
  c.thinkingVisibilityOverrides.set(0, false); // the override is the block's hidden flag
  c.invalidate();
  assert.deepEqual(c.render(60).map(plain), STOCK["thinking then text"].shown);
});

test("off Pi 0.87.x the render is Pi's own", (t) => {
  const owner = {};
  t.after(() => releaseHiddenThinking(owner));
  assert.equal(useHiddenThinking(owner, "0.88.0"), false);
  for (const [name, [m]] of Object.entries(SHAPES)) assert.deepEqual(render(m, true), STOCK[name].hidden, name);
});

test("children of a shape Pi 0.87 does not build keep Pi's render", (t) => {
  // A future Pi that adds a child: the patch sits on top of it and must leave it alone.
  const proto = AssistantMessageComponent.prototype;
  const stock = proto.updateContent;
  proto.updateContent = function (...a) {
    stock.apply(this, a);
    this.contentContainer.addChild(new Spacer(1));
  };
  const future = Object.fromEntries(Object.entries(SHAPES).map(([k, [m]]) => [k, [render(m, true), render(m, false)]]));
  const owner = {};
  t.after(() => {
    releaseHiddenThinking(owner);
    proto.updateContent = stock;
  });
  useHiddenThinking(owner, "0.87.1");
  for (const [name, [m]] of Object.entries(SHAPES)) assert.deepEqual([render(m, true), render(m, false)], future[name], name);
});

test("the patch is applied once while any session uses it and restored after the last", () => {
  const [a, b] = [{}, {}];
  const hidden = () => render(SHAPES["thinking and a call"][0], true);
  useHiddenThinking(a, "0.87.1");
  useHiddenThinking(a, "0.87.1");
  useHiddenThinking(b, "0.87.1");
  assert.deepEqual(render(SHAPES["thinking then text"][0], false).filter((l) => l.includes("Thinking")), [" ✻ Thinking"]); // not stacked
  releaseHiddenThinking(a);
  assert.deepEqual(hidden(), []);
  releaseHiddenThinking(b);
  assert.deepEqual(hidden(), STOCK["thinking and a call"].hidden);
});

test("the extension patches for its session's life: kept once over /reload, gone after /new, /resume or a reload without it", async (t) => {
  const session = await started((await scriptedSession(t, { extensions: [toolDisplay] })).session);
  const hidden = () => render(SHAPES["thinking and a call"][0], true);
  const labels = () => render(SHAPES["thinking then text"][0], false).filter((l) => l.includes("Thinking"));
  assert.deepEqual(hidden(), []);
  await session.reload(); // Pi's own /reload: shutdown, fresh extension instances
  await started(session);
  assert.deepEqual([hidden(), labels()], [[], [" ✻ Thinking"]]);
  for (const reason of ["new", "resume", "reload"]) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason });
    assert.deepEqual(hidden(), STOCK["thinking and a call"].hidden, reason);
    await session.extensionRunner.emit({ type: "session_start", reason });
    assert.deepEqual(hidden(), [], reason);
  }
});

test("the extension leaves rendering to Pi off Pi 0.87.x", async (t) => {
  await started((await scriptedSession(t, { extensions: [(pi) => toolDisplay(pi, "0.88.0")] })).session);
  assert.deepEqual(render(SHAPES["thinking and a call"][0], true), STOCK["thinking and a call"].hidden);
});

// Pi emits session_start from bindExtensions, which the scripted session skips.
const started = async (session) => (await session.extensionRunner.emit({ type: "session_start", reason: "startup" }), session);

// The session as Pi writes it: one JSON line per entry (SessionManager._rewriteFile).
const sessionFile = (session) => session.sessionManager.fileEntries.map((e) => JSON.stringify(e) + "\n").join("");

test("saved sessions are byte-identical with and without the patch; a group summary starts with thought ·", async (t) => {
  const { session, cwd } = await scriptedSession(t, {
    replies: [
      fauxAssistantMessage([fauxThinking("Let me look."), fauxToolCall("read", { path: "a.txt" }, { id: "r1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxThinking("Now answer."), fauxText("Done.")]),
    ],
    extensions: [toolDisplay],
    tools: ["read"],
  });
  await started(session);
  writeFileSync(join(cwd, "a.txt"), "one");
  await session.prompt("go");
  const without = sessionFile(session);
  // Everything the patch sees: each assistant message as it streams and ends, hidden
  // and shown, and every call the extension groups from it.
  for (const m of session.messages.filter((m) => m.role === "assistant")) {
    for (const hide of [true, false]) {
      const c = new AssistantMessageComponent(undefined, hide);
      c.updateContent(m, true);
      c.updateContent(m, false);
      c.setHideThinkingBlock(!hide);
      c.render(60);
    }
    await session.extensionRunner.emit({ type: "message_update", message: m });
    await session.extensionRunner.emit({ type: "message_end", message: m });
  }
  assert.deepEqual(render(session.messages.find((m) => m.role === "assistant"), true), []); // the patch ran
  assert.equal(sessionFile(session), without);
  assert.match(without, /"thinking":"Let me look\."/);

  const call = session.messages.find((m) => m.role === "assistant").content[1];
  const result = session.messages.find((m) => m.role === "toolResult");
  const tool = new ToolExecutionComponent("read", call.id, call.arguments, {}, session.getToolDefinition("read"), { requestRender() {} }, cwd);
  tool.updateResult({ content: result.content, details: result.details, isError: result.isError });
  assert.deepEqual(tool.render(80).map(plain), ["", " ⏺ thought · read 1 file"]);
});
