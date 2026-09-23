// Hidden thinking (#57): with the tool-display extension live, hidden thinking renders
// zero lines and shown thinking gets a restyled label; any other Pi (version or child
// shape) keeps Pi's own render; the patch lives exactly as long as a session using it;
// saved sessions are byte-identical with and without it; groups say "thought ·"; child
// sessions and /reload share the one patch.
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AssistantMessageComponent,
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

const { default: toolDisplay } = await import("../extensions/tool-display/index.ts");
const { useHiddenThinking, releaseHiddenThinking } = await import("../extensions/tool-display/thinking.ts");
const { Container, MouseRegion, Spacer } = await import("@earendil-works/pi-tui");

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
  // Overrides are per run: the other run of the message is still restyled.
  const two = new AssistantMessageComponent(SHAPES["two thinking runs around a call"][0], true);
  two.thinkingVisibilityOverrides.set(1, false);
  two.invalidate();
  assert.deepEqual(two.render(60).map(plain), ["", " Weighing it."]);
});

test("a throw while restyling leaves Pi's own children, not an empty message", (t) => {
  const owner = {};
  t.after(() => releaseHiddenThinking(owner));
  useHiddenThinking(owner, "0.87.1");
  const c = new AssistantMessageComponent(undefined, true);
  const box = c.contentContainer;
  const [clear, add] = [box.clear.bind(box), box.addChild.bind(box)];
  let clears = 0;
  let armed = false;
  box.clear = () => ((armed = ++clears === 2), clear()); // Pi's clear, then the restyle's
  box.addChild = (x) => {
    if (armed) {
      armed = false;
      throw new Error("forced");
    }
    add(x);
  };
  c.updateContent(SHAPES["thinking then text"][0]);
  assert.equal(clears, 3); // Pi's, the restyle's, then Pi's again
  assert.deepEqual(c.render(60).map(plain), STOCK["thinking then text"].hidden);
});

test("the last release leaves a later wrapper in place and the patch inert", (t) => {
  const proto = AssistantMessageComponent.prototype;
  const stock = proto.updateContent;
  const owner = {};
  t.after(() => {
    releaseHiddenThinking(owner);
    proto.updateContent = stock;
  });
  useHiddenThinking(owner, "0.87.1");
  const ours = proto.updateContent;
  const later = function (...a) {
    return ours.apply(this, a);
  };
  proto.updateContent = later;
  releaseHiddenThinking(owner);
  assert.equal(proto.updateContent, later);
  for (const [name, [m]] of Object.entries(SHAPES)) assert.deepEqual(render(m, true), STOCK[name].hidden, name);
});

test("off Pi 0.87.x the render is Pi's own", (t) => {
  const owner = {};
  t.after(() => releaseHiddenThinking(owner));
  assert.equal(useHiddenThinking(owner, "0.88.0"), false);
  for (const [name, [m]] of Object.entries(SHAPES)) assert.deepEqual(render(m, true), STOCK[name].hidden, name);
});

// Future Pis that change the children: one more child, another kind in a slot, or
// another component inside a thinking block's click region.
const FUTURES = {
  "an extra child": (kids) => kids.push(new Spacer(1)),
  "another kind of child": (kids) => kids.length && (kids[0] = new Container()),
  "another thinking component": (kids) => {
    for (const k of kids.filter((k) => k instanceof MouseRegion)) {
      const box = new Container();
      box.addChild(k.child);
      k.child = box;
    }
  },
};

for (const [change, alter] of Object.entries(FUTURES)) {
  test(`children of a shape Pi 0.87 does not build keep Pi's render: ${change}`, (t) => {
    // The patch sits on top of that Pi and must leave its render alone.
    const proto = AssistantMessageComponent.prototype;
    const stock = proto.updateContent;
    proto.updateContent = function (...a) {
      stock.apply(this, a);
      alter(this.contentContainer.children);
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
}

test("the patch is applied once while any session uses it and restored after the last", (t) => {
  const [a, b] = [{}, {}];
  t.after(() => [a, b].forEach(releaseHiddenThinking));
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

const REPLIES = () => [
  fauxAssistantMessage([fauxThinking("Let me look."), fauxToolCall("read", { path: "a.txt" }, { id: "r1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxThinking("Now answer."), fauxText("Done.")]),
];

// Renders each assistant message as Pi's chat does, from the live object while it
// streams and at its end, with thinking hidden and shown.
const chat = (pi) => {
  const draw = (e) => {
    if (e.message?.role !== "assistant") return;
    for (const hide of [true, false]) {
      const c = new AssistantMessageComponent(undefined, hide);
      c.updateContent(e.message, e.type === "message_update");
      c.setHideThinkingBlock(!hide);
      c.render(60);
    }
  };
  pi.on("message_update", draw);
  pi.on("message_end", draw);
};

// One scripted turn saved to `file` by Pi's own session writer. The helper's session
// manager is in-memory; switching it to a file and turning persistence on is the only
// way to get Pi to write the .jsonl (neither helper can save a session to disk).
async function savedRun(t, file, extensions) {
  let hidden;
  await t.test(file, async (t) => {
    const { session, cwd } = await scriptedSession(t, { replies: REPLIES(), extensions: [...extensions, chat], tools: ["read"] });
    await started(session);
    session.sessionManager.setSessionFile(file);
    session.sessionManager.persist = true;
    writeFileSync(join(cwd, "a.txt"), "one");
    await session.prompt("go");
    hidden = render(session.messages.find((m) => m.role === "assistant"), true);
  });
  return { hidden, text: readFileSync(file, "utf8") };
}

// Only what must differ between two runs: entry and session ids, timestamps, the cwd,
// and the id each faux provider gets when it is created.
function normalise(text) {
  const ids = new Map();
  return text
    .replace(/"cwd":"[^"]*"/g, '"cwd":"<cwd>"')
    .replace(/"(id|parentId)":"([^"]+)"/g, (_, k, v) => `"${k}":"<${ids.get(v) ?? ids.set(v, ids.size).get(v)}>"`)
    .replace(/"timestamp":("[^"]*"|\d+)/g, '"timestamp":"<time>"')
    .replace(/"api":"faux:[^"]*"/g, '"api":"faux:<id>"');
}

test("saved sessions are byte-identical with and without the extension", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rig-thinking-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const withIt = await savedRun(t, join(dir, "with.jsonl"), [toolDisplay]);
  const without = await savedRun(t, join(dir, "without.jsonl"), []);
  assert.deepEqual([withIt.hidden, without.hidden], [[], ["", " Thinking..."]]); // the patch ran only in one
  assert.match(withIt.text, /"thinking":"Let me look\."/);
  assert.equal(normalise(withIt.text), normalise(without.text));
});

test("a group summary starts with thought · when its message has thinking", async (t) => {
  const { session, cwd } = await scriptedSession(t, { replies: REPLIES(), extensions: [toolDisplay], tools: ["read"] });
  await started(session);
  writeFileSync(join(cwd, "a.txt"), "one");
  await session.prompt("go");
  const call = session.messages.find((m) => m.role === "assistant").content[1];
  const result = session.messages.find((m) => m.role === "toolResult");
  const tool = new ToolExecutionComponent("read", call.id, call.arguments, {}, session.getToolDefinition("read"), { requestRender() {} }, cwd);
  tool.updateResult({ content: result.content, details: result.details, isError: result.isError });
  assert.deepEqual(tool.render(80).map(plain), ["", " ⏺ thought · read 1 file"]);
});

// An in-process child session (a subagent) with its own copy of the extension.
async function child(t, parent, extensions) {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: parent.cwd, agentDir: parent.agentDir, settingsManager, extensionFactories: extensions,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: parent.cwd, agentDir: parent.agentDir, model: parent.faux.getModel(), resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(parent.cwd),
  });
  const stop = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  t.after(stop);
  return { session: await started(session), stop };
}

test("a child session ending leaves the parent's hidden thinking hidden", async (t) => {
  const parent = await scriptedSession(t, { extensions: [toolDisplay] });
  await started(parent.session);
  const kid = await child(t, parent, [toolDisplay]);
  await kid.stop();
  assert.deepEqual(render(SHAPES["thinking and a call"][0], true), []);
});

test("/reload with a child session up runs the reloaded code", async (t) => {
  // The parent loads the extension from a file, as Pi does, so /reload imports it anew.
  const dir = mkdtempSync(join(fileURLToPath(new URL("./fixtures/tool-display/", import.meta.url)), "reload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL("../extensions/tool-display/thinking.ts", import.meta.url), "utf8");
  const write = (label) => writeFileSync(join(dir, "thinking.ts"), source.replace('"✻ Thinking"', JSON.stringify(label)));
  writeFileSync(join(dir, "index.ts"), `import { releaseHiddenThinking, useHiddenThinking } from "./thinking.ts";
export default function (pi: any) {
  const owner = {};
  pi.on("session_start", () => useHiddenThinking(owner));
  pi.on("session_shutdown", () => releaseHiddenThinking(owner));
}
`);
  write("✻ Before");
  const parent = await scriptedSession(t, { extensions: [join(dir, "index.ts")] });
  await started(parent.session);
  await child(t, parent, [toolDisplay]);
  write("✻ After");
  await parent.session.reload();
  await started(parent.session);
  assert.deepEqual(render(SHAPES["thinking then text"][0], false), ["", " ✻ After", " Weighing it.", "", " Answer."]);
  assert.deepEqual(render(SHAPES["thinking and a call"][0], true), []);
});
