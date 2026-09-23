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

// A UI whose custom() runs each panel on the next key script.
function fakeUi(scripts) {
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
  const custom = (factory) =>
    new Promise((resolve) => {
      const component = factory({ requestRender() {} }, theme, undefined, resolve);
      for (const key of scripts.shift()) component.handleInput(key);
    });
  return new Proxy({ custom }, { get: (t, k) => t[k] ?? (() => {}) });
}

async function ask(t, questionSets, scripts, { ui = true, entries = [] } = {}) {
  const { session } = await scriptedSession(t, { replies: questionSets.flatMap(call), extensions: [EXTENSION], tools: ["ask_user"] });
  for (const [type, data] of entries) session.sessionManager.appendCustomEntry(type, data);
  if (ui) await session.bindExtensions({ uiContext: fakeUi(scripts), mode: "tui" });
  for (const _ of questionSets) await session.prompt("ask");
  return session;
}
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
