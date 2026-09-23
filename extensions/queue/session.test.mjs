// Scripted-model sessions for the message queue: what reaches the model, and when.
// Replies wait on gates the test opens, so input is queued while the agent works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "../../tests/helpers/session.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;

function gate() {
  let open, reached;
  const opened = new Promise((r) => (open = r));
  const waiting = new Promise((r) => (reached = r));
  return { open, waiting, wait: () => (reached(), opened) };
}

const KEYS = { "alt+up": "\x1b[1;3A", "alt+down": "\x1b[1;3B", "alt+x": "\x1bx", escape: "\x1b" };
const say = (text) => fauxAssistantMessage(fauxText(text));
const tool = () => fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" });

// A TUI-mode UI with an editor, key listeners, notices and rendered widget rows.
function fakeUi(session) {
  // Pi's /reload handler clears the editor, then reloads.
  const editor = { getText: () => state.editor, onSubmit: (text) => text === "/reload" && ((state.editor = ""), session.reload()) };
  const state = { editor: "", notices: [], widget: [], keys: [], focus: editor };
  const tui = { getFocusedComponent: () => state.focus };
  const theme = { fg: (_c, s) => s };
  const target = {
    setWidget: (_k, w) => (state.widget = w ? w(tui, theme).render(80) : []),
    getEditorText: () => state.editor,
    setEditorText: (t) => (state.editor = t),
    notify: (m, type = "info") => state.notices.push(`${type}: ${m}`),
    onTerminalInput: (h) => (state.keys.push(h), () => state.keys.splice(state.keys.indexOf(h), 1)),
    setEditorComponent: () => (state.editorReplaced = true),
    setFooter: () => (state.footerReplaced = true),
  };
  const ui = new Proxy(target, { get: (t, p) => t[p] ?? (() => undefined) });
  return { ui, state };
}

async function start(t, replies, extensions = []) {
  const s = await scriptedSession(t, { replies, extensions: [EXT, ...extensions], tools: ["ls"] });
  const { ui, state } = fakeUi(s.session);
  await s.session.bindExtensions({ uiContext: ui, mode: "tui" });
  // Raw terminal input, as Pi hands it to listeners before its editor.
  const press = (key) => state.keys.forEach((h) => h(KEYS[key]));
  return { ...s, state, press };
}

// The saved conversation: user texts, assistant replies and compactions, in order.
const transcript = (session) =>
  session.sessionManager.getBranch().flatMap((e) => (e.type === "compaction" ? [{ role: "compactionSummary" }] : e.type === "message" ? [e.message] : [])).flatMap((m) =>
    m.role === "user"
      ? [`user: ${(typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")).slice(0, 1000)}`]
      : m.role === "assistant"
        ? [`assistant: ${m.content.map((c) => c.text ?? `[${c.name}]`).join("").slice(0, 40)}`]
        : m.role === "compactionSummary"
          ? ["[compacted]"]
          : [],
  );

test("steering goes in at the next turn boundary, follow-ups after the run, each first in first out", async (t) => {
  const g = gate();
  const { session, state } = await start(t, [async () => (await g.wait(), tool()), say("turned"), say("done"), say("f1"), say("f2")]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("s1", { streamingBehavior: "steer" });
  await session.prompt("f1", { streamingBehavior: "followUp" });
  await session.prompt("s2", { streamingBehavior: "steer" });
  await session.prompt("f2", { streamingBehavior: "followUp" });
  assert.deepEqual(state.widget, [" Steering (2) · next turn", "   s1", "   s2", " Follow-ups (2) · after the run", "   f1", "   f2"]);
  g.open();
  await run;
  await session.agent.waitForIdle?.();
  assert.deepEqual(transcript(session), [
    "user: go",
    "assistant: [ls]",
    "user: s1",
    "assistant: turned",
    "user: s2",
    "assistant: done",
    "user: f1",
    "assistant: f1",
    "user: f2",
    "assistant: f2",
  ]);
  assert.deepEqual(state.widget, []);
});

test("edit in place, delete and cancel change what is delivered; the draft comes back", async (t) => {
  const g = gate();
  const { session, state, press } = await start(t, [async () => (await g.wait(), tool()), say("turned"), say("f")]);
  const run = session.prompt("go");
  await g.waiting;
  for (const [text, lane] of [["s1", "steer"], ["s2", "steer"], ["f1", "followUp"]]) {
    await session.prompt(text, { streamingBehavior: lane });
  }
  state.editor = "my draft";
  press("alt+up"); // the most recent: f1
  assert.equal(state.editor, "f1");
  assert.deepEqual(state.widget, [" Steering (2) · next turn", "   s1", "   s2", " Follow-ups (1) · after the run", " › f1"]);
  await session.prompt("f1 edited", { streamingBehavior: "steer" }); // Enter saves in place
  assert.equal(state.editor, "my draft");

  press("alt+up");
  press("alt+up"); // up to s2
  assert.equal(state.editor, "s2");
  press("alt+x"); // s2 gone; f1 edited is selected
  assert.equal(state.editor, "f1 edited");
  state.editor = "thrown away";
  press("escape"); // Esc cancels
  assert.equal(state.editor, "my draft");
  assert.deepEqual(state.widget, [" Steering (1) · next turn", "   s1", " Follow-ups (1) · after the run", "   f1 edited"]);

  g.open();
  await run;
  assert.deepEqual(transcript(session), ["user: go", "assistant: [ls]", "user: s1", "assistant: turned", "user: f1 edited", "assistant: f"]);
});

test("a message delivered while it is being edited ends the edit with a notice", async (t) => {
  const g = gate();
  const { session, state, press } = await start(t, [async () => (await g.wait(), tool()), say("turned")]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("s1", { streamingBehavior: "steer" });
  state.editor = "draft";
  press("alt+up");
  state.editor = "half edi";
  g.open();
  await run;
  assert.equal(state.editor, "draft");
  assert.deepEqual(state.notices, ["info: The queued message you were editing was delivered"]);
  assert.deepEqual(transcript(session), ["user: go", "assistant: [ls]", "user: s1", "assistant: turned"]);
});

test("abort keeps the queue, paused, until the next submission", async (t) => {
  const g = gate();
  const { session, state } = await start(t, [async () => (await g.wait(), tool()), say("fresh"), say("s-reply"), say("f-reply")]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("s1", { streamingBehavior: "steer" });
  await session.prompt("f1", { streamingBehavior: "followUp" });
  const aborting = session.abort();
  g.open();
  await Promise.all([run, aborting]);
  assert.deepEqual(state.widget, [" Steering (1) · paused", "   s1", " Follow-ups (1) · paused", "   f1"]);
  assert.deepEqual(transcript(session).slice(0, 1), ["user: go"]);

  await session.prompt("new prompt");
  assert.deepEqual(transcript(session).slice(-6), [
    "user: new prompt",
    "assistant: fresh",
    "user: s1",
    "assistant: s-reply",
    "user: f1",
    "assistant: f-reply",
  ]);
  assert.deepEqual(state.widget, []);
});

// Resolves when a reply for `text` (the last user message) is requested.
function replyTo(text) {
  let seen;
  const requested = new Promise((r) => (seen = r));
  const lastUser = (context) => {
    const m = context.messages.findLast((m) => m.role === "user");
    return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");
  };
  return { requested, reply: (context) => (lastUser(context) === text && seen(), say(lastUser(context) === text ? `re: ${text}` : "summary")) };
}

test("/compact then continue run in order once the agent is idle", async (t) => {
  const g = gate();
  const next = replyTo("continue");
  const { session, state } = await start(t, [async () => (await g.wait(), say("x".repeat(100_000))), next.reply, next.reply, next.reply]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("/compact", { streamingBehavior: "followUp" });
  await session.prompt("continue", { streamingBehavior: "steer" });
  assert.deepEqual(state.widget, [" Steering (1) · next turn", "   continue", " Follow-ups (1) · after the run", " ⚙ /compact · runs when idle"]);
  g.open();
  await run;
  await next.requested;
  await session.agent.waitForIdle();
  assert.deepEqual(transcript(session).slice(-3), ["[compacted]", "user: continue", "assistant: re: continue"]);
  assert.deepEqual(state.notices, []);
  assert.deepEqual(state.widget, []);
});

test("a queued /compact with nothing to compact is only a notice", async (t) => {
  const g = gate();
  const next = replyTo("next");
  const { session, state } = await start(t, [async () => (await g.wait(), say("short")), next.reply]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("/compact", { streamingBehavior: "followUp" });
  await session.prompt("next", { streamingBehavior: "followUp" });
  g.open();
  await run;
  await next.requested;
  await session.agent.waitForIdle();
  assert.deepEqual(state.notices, ["info: Nothing to compact"]);
  assert.deepEqual(transcript(session), ["user: go", "assistant: short", "user: next", "assistant: re: next"]);
});

test("rows queued behind /reload survive the reload and are then delivered", async (t) => {
  const g = gate();
  const next = replyTo("after");
  const starts = [];
  const { session, state } = await start(t, [async () => (await g.wait(), say("before")), next.reply], [
    (pi) => pi.on("session_start", (e) => starts.push(e.reason)),
  ]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("/reload", { streamingBehavior: "followUp" });
  await session.prompt("after", { streamingBehavior: "followUp" });
  g.open();
  await run;
  await next.requested;
  await session.agent.waitForIdle();
  assert.deepEqual(starts, ["startup", "reload"]);
  assert.deepEqual(transcript(session), ["user: go", "assistant: before", "user: after", "assistant: re: after"]);
  assert.deepEqual(state.widget, []);
});

test("skill commands in a queued message are expanded on delivery", async (t) => {
  const g = gate();
  const skills = new URL("../../tests/fixtures/queue/skills", import.meta.url).pathname;
  const s = await scriptedSession(t, {
    replies: [async () => (await g.wait(), tool()), say("ok")],
    extensions: [EXT, (pi) => pi.on("resources_discover", () => ({ skillPaths: [skills] }))],
    tools: ["ls"],
  });
  await s.session.bindExtensions({ uiContext: fakeUi(s.session).ui, mode: "tui" });
  const run = s.session.prompt("go");
  await g.waiting;
  await s.session.prompt("/skill:demo please", { streamingBehavior: "steer" });
  g.open();
  await run;
  const delivered = transcript(s.session)[2];
  assert.match(delivered, /^user: <skill name="demo"[^]*Demo skill body\.\n<\/skill>\n\nplease$/);
});

test("input from RPC drivers and extensions passes through to Pi's own queue", async (t) => {
  const g = gate();
  const { session, state } = await start(t, [async () => (await g.wait(), tool()), say("ok")]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("from rpc", { streamingBehavior: "steer", source: "rpc" });
  await session.prompt("from extension", { streamingBehavior: "steer", source: "extension" });
  assert.deepEqual(state.widget, []);
  assert.equal(session.getSteeringMessages().length, 2);
  g.open();
  await run;
});

test("adds no tools, commands or editor, and leaves nothing behind at shutdown", async (t) => {
  const g = gate();
  const { session, state } = await start(t, [async () => (await g.wait(), tool()), say("ok")]);
  assert.deepEqual(session.extensionRunner.getRegisteredCommands(), []);
  assert.deepEqual(session.getAllTools().map((x) => x.name), ["ls"]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("pending", { streamingBehavior: "followUp" });
  assert.equal(state.keys.length, 1);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(state.keys, []);
  assert.equal(state.editorReplaced, undefined);
  assert.equal(state.footerReplaced, undefined);
  g.open();
  await run;
  assert.deepEqual(transcript(session), ["user: go", "assistant: [ls]", "assistant: ok"]); // the queue died with the session
});

test("a queued /compact is Pi's call: a large session Pi cannot compact gives the notice and moves on", { timeout: 15_000 }, async (t) => {
  // One prompt over keepRecentTokens: Pi keeps it whole, so there is nothing to summarise.
  const g = gate();
  const next = replyTo("next");
  const { session, state } = await start(t, [async () => (await g.wait(), say("short")), next.reply]);
  const run = session.prompt("y".repeat(100_000));
  await g.waiting;
  await session.prompt("/compact", { streamingBehavior: "followUp" });
  await session.prompt("next", { streamingBehavior: "followUp" });
  g.open();
  await run;
  await next.requested;
  await session.agent.waitForIdle();
  assert.deepEqual(state.notices, ["info: Nothing to compact"]);
  assert.deepEqual(transcript(session).slice(-3), ["assistant: short", "user: next", "assistant: re: next"]);
  assert.deepEqual(state.widget, []);
});

// Resolves on each session_start reason "reload".
function reloads() {
  const seen = [];
  let wake;
  const next = () => new Promise((r) => (wake = r));
  const ext = (pi) => pi.on("session_start", (e) => e.reason === "reload" && (seen.push(e), wake?.()));
  return { seen, next, ext };
}

test("a queued /reload keeps the draft typed while it waited", async (t) => {
  const g = gate();
  const r = reloads();
  const { session, state } = await start(t, [async () => (await g.wait(), say("before"))], [r.ext]);
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("/reload", { streamingBehavior: "followUp" });
  state.editor = "half-typed draft";
  const reloaded = r.next();
  g.open();
  await run;
  await reloaded;
  assert.equal(state.editor, "half-typed draft");
});

test("a queued /reload waits while a picker or the label editor has focus", async (t) => {
  const g = gate();
  const r = reloads();
  const { session, state, press } = await start(t, [async () => (await g.wait(), say("before"))], [r.ext]);
  const main = state.focus;
  const submitted = [];
  const labelEditor = { getText: () => "a label", onSubmit: (text) => submitted.push(text) };
  const run = session.prompt("go");
  await g.waiting;
  await session.prompt("/reload", { streamingBehavior: "followUp" });
  state.focus = labelEditor;
  g.open();
  await run;
  await session.agent.waitForIdle();
  press("escape"); // a key while the label editor still has focus
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  assert.deepEqual(r.seen, []);
  assert.deepEqual(state.widget, [" Follow-ups (1) · after the run", " ⚙ /reload · runs when idle"]);

  state.focus = main; // the label editor closed
  const reloaded = r.next();
  press("escape");
  await reloaded;
  assert.equal(r.seen.length, 1);
  assert.deepEqual(submitted, []);
});

test("a saved queue that no reload in this process wrote is never restored", async (t) => {
  const r = reloads();
  const { session, state } = await start(t, [say("unused")], [r.ext]);
  // As if the process died after saving: the entry is in the session, no token is in memory.
  session.sessionManager.appendCustomEntry("rig.queue", { token: "stale", rows: [{ lane: "followUp", text: "old" }], draft: "old draft" });
  await session.reload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.seen.length, 1);
  assert.deepEqual(state.widget, []);
  assert.equal(state.editor, "");
  assert.deepEqual(transcript(session), []);
});
