// /context with scripted models (#61): it never aborts a real turn, its silent
// probe leaves nothing in the transcript or the model's context, and the
// injections view counts system messages extensions add on Pi 0.87.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, scriptedSession } from "./helpers/session.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const CONTEXT = root("extensions/context/index.ts");
const plain = new Proxy({}, { get: (_t, key) => (key === "fg" || key === "bg" ? (_k, text) => text : (text) => text) });

// A TUI stand-in: views render once at 80x40 and close at once.
function attachUi(session) {
  const screens = [];
  session.extensionRunner.setUIContext(
    {
      notify() {},
      setWorkingVisible() {},
      async custom(factory) {
        const view = factory({ terminal: { rows: 40 }, requestRender() {} }, plain, {}, () => {});
        screens.push(view.render(80).join("\n"));
      },
    },
    "tui",
  );
  return screens;
}

const text = (message) => message.content.map((b) => b.text ?? "").join("");
const transcript = (session) =>
  session.sessionManager
    .getEntries()
    .filter((e) => e.type === "message" && ["user", "assistant"].includes(e.message.role))
    .map((e) => e.message)
    .filter((m) => m.content.length > 0) // Pi renders no row for an empty message
    .map((m) => `${m.role}: ${text(m)}${m.stopReason && m.stopReason !== "stop" ? ` [${m.stopReason}]` : ""}`);

test("/context during an active turn never aborts it", async (t) => {
  let release, requested;
  const gate = new Promise((r) => (release = r));
  const started = new Promise((r) => (requested = r));
  const { session } = await scriptedSession(t, {
    extensions: [CONTEXT],
    replies: [async () => (requested(), await gate, fauxAssistantMessage("done"))],
  });
  const screens = attachUi(session);

  const turn = session.prompt("hello");
  await started; // the model request is in flight
  await session.prompt("/context");
  release();
  await turn;

  assert.match(screens[0], /Context Usage/);
  assert.deepEqual(transcript(session), ["user: hello", "assistant: done"]);
});

test("the silent probe leaves no rows in the transcript and never reaches the model", async (t) => {
  const seen = [];
  const { session, faux } = await scriptedSession(t, {
    extensions: [CONTEXT],
    replies: [(context) => (seen.push(context.messages.filter((m) => m.role !== "system").map(text)), fauxAssistantMessage("hi"))],
  });
  const screens = attachUi(session);

  await session.prompt("/context injections"); // before any turn: the probe runs
  assert.match(screens[0], /Context Injections/);
  assert.equal(faux.state.callCount, 0);

  await session.prompt("hello");
  assert.deepEqual(seen, [["hello"]]);
  assert.deepEqual(transcript(session), ["user: hello", "assistant: hi"]);
});

test("the probe's aborted reply keeps no usage, so /usage bills nothing for it", async (t) => {
  const { session } = await scriptedSession(t, { extensions: [root("tests/fixtures/context/billing.ts"), CONTEXT] });
  attachUi(session);
  await session.prompt("/context");
  const replies = session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "assistant");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.usage.input, 0);
  assert.equal(replies[0].message.usage.cost.total, 0);
});

test("injections include a system message another extension adds to the request", async (t) => {
  const { session } = await scriptedSession(t, {
    extensions: [root("tests/fixtures/context/inject.ts"), CONTEXT],
    replies: [fauxAssistantMessage("hi")],
  });
  const screens = attachUi(session);
  await session.prompt("hello");
  await session.prompt("/context injections");
  assert.match(screens[0], /unattributed \.+ 5\n {2}└─ system message \.+ 5\n/);
});

test("a probe that arrives after its 5 s timeout is still aborted and leaves no rows", async (t) => {
  let reached, release, settled;
  const atProbe = new Promise((r) => (reached = r));
  const gate = new Promise((r) => (release = r));
  const probeDone = new Promise((r) => (settled = r));
  // Loaded after /context: holds the probe run inside before_agent_start, after
  // /context has claimed it, until the test has fired the timeout.
  const slow = (pi) => {
    pi.on("before_agent_start", async (event) => {
      if (event.prompt !== "") return;
      reached();
      await gate;
    });
    // Pi defers prompts made while it is still emitting agent_settled; resolve once it is done.
    pi.on("agent_settled", () => void setImmediate(settled));
  };
  const { session, faux } = await scriptedSession(t, { extensions: [CONTEXT, slow], replies: [fauxAssistantMessage("hi")] });
  const screens = attachUi(session);
  t.mock.timers.enable({ apis: ["setTimeout"] }); // the injected clock for the probe timeout

  const command = session.prompt("/context");
  await atProbe;
  t.mock.timers.tick(5_000); // the probe times out; /context falls back
  await command;
  assert.match(screens[0], /Silent probe timed out/);

  t.mock.timers.reset();
  release(); // the late probe run goes on
  await probeDone;
  assert.equal(faux.state.callCount, 0); // aborted before the model was called
  assert.deepEqual(transcript(session), []);

  await session.prompt("hello");
  console.log(session.isIdle, JSON.stringify(session.sessionManager.getEntries().map(e=>[e.type,e.message?.role,e.message?.content,e.message?.stopReason,e.message?.errorMessage])));
  assert.deepEqual(transcript(session), ["user: hello", "assistant: hi"]);
});
