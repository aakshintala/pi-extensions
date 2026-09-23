// Scripted-model sessions for ask_user (spec #34): schema, no UI, result format, subagents.
// The panel is driven in-process: a fake ui.custom() feeds keys to the component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "../../tests/helpers/session.mjs";

const EXTENSION = fileURLToPath(new URL("./index.ts", import.meta.url));
const K = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t", space: " " };

const call = (questions) => [
  fauxAssistantMessage(fauxToolCall("ask_user", { questions }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("ok")),
];

// A UI whose custom() runs each panel on the next key script; `frames` holds each
// panel's renders at WIDTH, before and after each key. `onOpen` runs once the panel is up.
const WIDTH = 40;
function fakeUi(scripts, frames, onOpen) {
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
  const custom = (factory) =>
    new Promise((resolve) => {
      const component = factory({ requestRender() {} }, theme, undefined, resolve);
      const renders = [component.render(WIDTH)];
      for (const key of scripts.shift()) component.handleInput(key), renders.push(component.render(WIDTH));
      frames.push(renders.flat());
      onOpen?.();
    });
  return new Proxy({ custom }, { get: (t, k) => t[k] ?? (() => {}) });
}

async function ask(t, questionSets, scripts, { ui = true, entries = [], frames = [], onOpen } = {}) {
  const { session } = await scriptedSession(t, { replies: questionSets.flatMap(call), extensions: [EXTENSION], tools: ["ask_user"] });
  for (const [type, data] of entries) session.sessionManager.appendCustomEntry(type, data);
  if (ui) await session.bindExtensions({ uiContext: fakeUi(scripts, frames, onOpen && (() => onOpen(session))), mode: "tui" });
  for (const _ of questionSets) await session.prompt("ask");
  return session;
}
// Visible text of a rendered line: escape sequences (cursor marker, inverse video) removed.
const plain = (line) => line.replace(/\x1b_[^\x07]*\x07|\x1b\[[0-9;]*m/g, "");
const results = (session) => session.messages.filter((m) => m.role === "toolResult").map((m) => [m.isError, m.content[0].text]);

const Q = (header, extra = {}) => ({
  question: `Pick a ${header}?`,
  header,
  options: [{ label: "A", description: "first" }, { label: "B" }, { label: "C" }],
  ...extra,
});

test("result lines for chosen, typed, multi-select with text, skipped, note and cancelled", async (t) => {
  const three = [Q("one"), Q("two", { multiSelect: true }), { question: "Why?", header: "three" }];
  const session = await ask(
    t,
    [[Q("solo")], three, three, [Q("solo")]],
    [
      [K.down, K.enter], // single question submits at once
      [
        K.down, K.down, K.down, ..."not A", K.enter, // typed on the free-text row
        K.space, K.down, K.down, K.space, K.down, ..."and more", K.enter, // A, C + text
        K.tab, // skip "three" into review
        ..."be quick", K.enter, K.enter, // note, then Submit
      ],
      [K.tab, K.tab, K.tab, K.down, K.enter], // skip everything; review Submit
      [K.esc],
    ],
  );
  assert.deepEqual(results(session), [
    [false, "solo: B"],
    [false, 'one: "not A"\ntwo: A, C, "and more"\nthree: skipped\nnote: be quick'],
    [false, "one: skipped\ntwo: skipped\nthree: skipped"],
    [false, "cancelled"],
  ]);
});

test("review jumps back to a question to change its answer", async (t) => {
  const session = await ask(t, [[Q("one"), Q("two")]], [[K.enter, K.enter, K.up, K.up, K.enter, K.down, K.enter, K.enter, K.enter, K.enter]]);
  // A, A, then from review up to "one", Enter jumps back; B, "two" again, note row, Submit.
  assert.deepEqual(results(session), [[false, "one: B\ntwo: A"]]);
});

test("invalid questions are rejected before any panel opens", async (t) => {
  const bad = [
    [],
    [Q("a"), Q("b"), Q("c"), Q("d"), Q("e")],
    [Q("thirteen-char")],
    [{ question: "x", header: "h", options: [{ label: "only" }] }],
  ];
  const session = await ask(t, bad, []);
  const r = results(session);
  assert.equal(r.length, 4);
  for (const [isError, text] of r) {
    assert.equal(isError, true);
    assert.match(text, /Validation failed for tool "ask_user"/);
  }
});

test("without an interactive UI ask_user errors and says to state an assumption", async (t) => {
  const session = await ask(t, [[Q("one")]], [], { ui: false });
  assert.deepEqual(results(session), [[true, "No interactive user here. State your assumption and continue."]]);
});

test("a session holding rig.subagent has no ask_user", async (t) => {
  const session = await ask(t, [], [], { entries: [["rig.subagent", { agentId: "a1", parentSessionId: "p" }]] });
  assert.equal(session.getActiveToolNames().includes("ask_user"), false);
});

test("a normal session has ask_user", async (t) => {
  const session = await ask(t, [], []);
  assert.equal(session.getActiveToolNames().includes("ask_user"), true);
});

test("model text is shown and returned as one plain line", async (t) => {
  const frames = [];
  const q = { question: "Pick\none\x1b[2J", header: "h\x1b[31m\ni", options: [{ label: "A\x1b[2J\nB", description: "d\ne" }, { label: "C" }] };
  await ask(t, [[q, q]], [[K.enter, K.tab, K.esc]], { frames }); // answer, review, close
  for (const line of frames[0]) assert.doesNotMatch(line, /\x1b\[2J|\x1b\[31m|\n/);
  assert.ok(frames[0].some((l) => plain(l).includes("h i: A B")));
});

test("result lines hold model text on one line", async (t) => {
  const q = { question: "Pick\none", header: "h\ni", options: [{ label: "A\x1b[2J\nB" }, { label: "C" }] };
  const session = await ask(t, [[q]], [[K.enter]]);
  assert.deepEqual(results(session), [[false, "h i: A B"]]);
});

test("aborting the turn closes the open panel as cancelled", async (t) => {
  const session = await ask(t, [[Q("one")]], [[]], { onOpen: (s) => s.abort() });
  assert.deepEqual(results(session).map(([, text]) => text), ["cancelled"]);
});

test("a single question is skipped with Enter on the empty text row", async (t) => {
  const session = await ask(t, [[Q("solo")], [{ question: "Why?", header: "why" }]], [[K.up, K.enter, K.esc], [K.enter, K.esc]]); // Esc: a regression reads cancelled
  assert.deepEqual(results(session), [[false, "solo: skipped"], [false, "why: skipped"]]);
});

test("the focused text row fits the panel width", async (t) => {
  const frames = [];
  await ask(t, [[Q("m", { multiSelect: true })], [Q("s")]], [[K.up, ..."hi", K.esc], [K.up, ..."hi", K.esc]], { frames });
  for (const frame of frames) {
    const row = frame.map(plain).find((l) => l.includes("hi"));
    assert.equal(row.endsWith("..."), false, row);
    assert.ok(row.length <= WIDTH, row);
  }
});

test("a header wider than 12 columns is rejected", async (t) => {
  const session = await ask(t, [[Q("日本語日本語日本")]], [[K.esc]]); // Esc: a regression fails, not hangs
  const [[isError, text]] = results(session);
  assert.equal(isError, true);
  assert.match(text, /header .* wider than 12 columns/);
});

test("removed fields such as allowSkip or preview are rejected", async (t) => {
  const session = await ask(t, [[Q("a", { allowSkip: true })], [Q("b", { options: [{ label: "x", preview: "p" }, { label: "y" }] })]], []);
  for (const [isError, text] of results(session)) {
    assert.equal(isError, true);
    assert.match(text, /Validation failed for tool "ask_user"/);
  }
});

test("Tab does nothing when there is one question", async (t) => {
  const session = await ask(t, [[Q("solo")]], [[K.up, "a", K.tab, "\x1b[9u", "b", K.enter]]);
  assert.deepEqual(results(session), [[false, 'solo: "ab"']]);
});
