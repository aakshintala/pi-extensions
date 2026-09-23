// Scripted-model sessions for todo_write: tool results, the rebuilt list, what goes
// into each request, and what the widget is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "../../tests/helpers/session.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;
const REMINDER = /<system-reminder>/;

const write = (todos) => fauxAssistantMessage(fauxToolCall("todo_write", { todos }), { stopReason: "toolUse" });
const say = (text = "ok") => fauxAssistantMessage(fauxText(text));

// Wraps a scripted reply so the request it answers is recorded.
const recorded = (requests, reply) => (context) => {
  requests.push(JSON.stringify(context.messages));
  return typeof reply === "function" ? reply(context) : reply;
};

// A TUI-mode UI that records every widget the extension sets; everything else is a no-op.
function fakeUi() {
  const widgets = [];
  const ui = new Proxy({ setWidget: (key, lines) => widgets.push([key, lines]) }, {
    get: (target, prop) => target[prop] ?? (() => undefined),
  });
  return { ui, widgets };
}

async function start(t, replies) {
  const s = await scriptedSession(t, { replies, extensions: [EXT], tools: ["todo_write"] });
  const { ui, widgets } = fakeUi();
  await s.session.bindExtensions({ uiContext: ui, mode: "tui" });
  return { ...s, widgets };
}

const results = (session) =>
  session.messages.filter((m) => m.role === "toolResult").map((m) => [m.isError, m.content[0].text]);

test("todo_write replaces the list, clears it, and rejects invalid input", async (t) => {
  const { session, cwd, widgets } = await start(t, [
    write([{ text: "plan", status: "completed" }, { text: "build", status: "in_progress" }, { text: "ship", status: "pending" }]),
    write([{ text: "ship", status: "in_progress" }]),
    write([]),
    write([{ text: "x", status: "done" }]),
    write([{ text: "  ", status: "pending" }]),
    say(),
  ]);
  await session.prompt("go");

  assert.deepEqual(results(session).slice(0, 3), [
    [false, "Todo list saved: 1 pending, 1 in_progress, 1 completed."],
    [false, "Todo list saved: 0 pending, 1 in_progress, 0 completed."],
    [false, "Todo list cleared."],
  ]);
  const [badStatus, emptyText] = results(session).slice(3);
  assert.equal(badStatus[0], true);
  assert.match(badStatus[1], /status/);
  assert.deepEqual(emptyText, [true, "todos[0].text is empty"]);

  assert.deepEqual(widgets, [
    ["todo", undefined], // session start, no list
    ["todo", ["✔ 1 done", "◼ build", "◻ ship"]],
    ["todo", ["◼ ship"]],
    ["todo", undefined],
  ]);
  assert.deepEqual(readdirSync(cwd), []);
});

test("reminder rides only the next request after a no-tool-call turn with an item in progress", async (t) => {
  const requests = [];
  const { session } = await start(t, [
    write([{ text: "build", status: "in_progress" }, { text: "ship", status: "pending" }]),
    say("stopping here"),
    recorded(requests, write([{ text: "build", status: "completed" }, { text: "ship", status: "in_progress" }])),
    recorded(requests, say()),
  ]);
  await session.prompt("one");
  await session.prompt("two");

  assert.equal(requests.length, 2);
  assert.match(requests[0], /Todo items still in progress: \\"build\\"\. Update your list with todo_write/);
  assert.doesNotMatch(requests[1], REMINDER); // the turn that followed called a tool
  assert.doesNotMatch(JSON.stringify(session.sessionManager.getEntries()), REMINDER);
});

test("no reminder without an in-progress item or after a tool-call turn", async (t) => {
  const requests = [];
  const { session } = await start(t, [
    recorded(requests, say()), // never used the tool
    recorded(requests, write([{ text: "a", status: "pending" }, { text: "b", status: "completed" }])),
    recorded(requests, say()),
    recorded(requests, say()), // list has nothing in progress
    recorded(requests, write([{ text: "c", status: "in_progress" }])),
    recorded(requests, say()), // same run, right after the tool call
  ]);
  await session.prompt("one");
  await session.prompt("two");
  await session.prompt("three");
  await session.prompt("four");

  assert.equal(requests.length, 6);
  for (const r of requests) assert.doesNotMatch(r, REMINDER);
});

test("the list is rebuilt on resume and at a branch point", async (t) => {
  const requests = [];
  const { session, widgets } = await start(t, [
    write([{ text: "first", status: "in_progress" }]),
    say("one done"),
    write([{ text: "second", status: "in_progress" }]),
    say("two done"),
    recorded(requests, say()),
    recorded(requests, say()),
  ]);
  await session.prompt("one");
  await session.prompt("two");

  // Resume: a fresh extension instance rebuilds from the saved entries.
  await session.reload();
  assert.deepEqual(widgets.at(-1), ["todo", ["◼ second"]]);
  await session.prompt("three");
  assert.match(requests[0], /in progress: \\"second\\"/);

  // Branch back to the end of the first run: the list from that timeline returns.
  const branchPoint = session.sessionManager
    .getBranch()
    .find((e) => e.type === "message" && e.message.role === "assistant" && e.message.content[0]?.text === "one done");
  await session.navigateTree(branchPoint.id);
  assert.deepEqual(widgets.at(-1), ["todo", ["◼ first"]]);
  await session.prompt("four");
  assert.match(requests[1], /in progress: \\"first\\"/);
  assert.doesNotMatch(requests[1], /second/);
});

test("a subagent session keeps its own list and draws no widget", async (t) => {
  const requests = [];
  const { session, widgets, faux, cwd, agentDir } = await start(t, [
    write([{ text: "parent task", status: "in_progress" }]),
    say(),
    write([{ text: "child task", status: "in_progress" }]),
    say(),
    recorded(requests, say()),
    recorded(requests, say()),
  ]);
  await session.prompt("parent plans");

  // A child in the same process, loading the extension itself, marked with rig.subagent.
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendCustomEntry("rig.subagent", { agentId: "a1", parentSessionId: session.sessionId });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [EXT],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session: child } = await createAgentSession({
    cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime: session.modelRuntime,
    resourceLoader, settingsManager, sessionManager, tools: ["todo_write"],
  });
  t.after(() => child.dispose());
  const childUi = fakeUi();
  await child.bindExtensions({ uiContext: childUi.ui, mode: "tui" });
  await child.prompt("child plans");

  await child.prompt("child again");
  await session.prompt("parent again");
  assert.match(requests[0], /in progress: \\"child task\\"/);
  assert.doesNotMatch(requests[0], /parent task/);
  assert.match(requests[1], /in progress: \\"parent task\\"/);
  assert.doesNotMatch(requests[1], /child task/);
  assert.deepEqual(childUi.widgets, []);
  assert.deepEqual(widgets.at(-1), ["todo", ["◼ parent task"]]);
});
