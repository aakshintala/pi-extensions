// Notice delivery and the session-end rule (#46) in scripted SDK sessions, which
// run without the UI. Items are registered straight on the shared registry; the
// fleet extension is loaded like any other, so it sees the same registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { fleet } from "../shared/fleet/index.ts";

const FLEET = fileURLToPath(new URL("../extensions/fleet/index.ts", import.meta.url));
const BEFORE_SETTLE = fileURLToPath(new URL("./fixtures/fleet/before-settle.ts", import.meta.url));

// The model's view of the conversation: the last message it was sent.
const lastText = (context) => {
  const content = context.messages.at(-1).content;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
};
const says = (text) => () => fauxAssistantMessage(fauxText(text));
const echo = (context) => fauxAssistantMessage(fauxText(`saw: ${lastText(context)}`));

// The transcript as the user would read it, one line per message.
const transcript = (session) =>
  session.messages.filter((m) => m.role !== "system").map((m) => {
    const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? `call ${c.name}`).join("");
    return `${m.role === "toolResult" ? "tool" : m.role}: ${text}`;
  });

function add(id, owner, extra = {}) {
  fleet().register({ id, owner, kind: "shell", label: `job ${id}`, activity: () => "", view: { log: "/dev/null" }, stop() {}, ...extra });
}

const HOOK = Symbol.for("pi-rig.test.beforeSettle");

// `onSettle(n, event)` runs ahead of the fleet extension at each agent_before_settle.
async function start(t, replies, { extensions = [], bindings = {}, onSettle } = {}) {
  const s = await scriptedSession(t, { replies, extensions: [BEFORE_SETTLE, FLEET, ...extensions] });
  await s.session.bindExtensions(bindings); // emits session_start, as pi does
  const registry = fleet();
  const { now, subscribe } = registry;
  registry.now = () => 0;
  let settles = 0;
  globalThis[HOOK] = (event) => onSettle?.(++settles, event);
  t.after(() => {
    for (const item of registry.items()) registry.finish(item.id, "stopped", "test over", null);
    registry.prune();
    Object.assign(registry, { now, subscribe });
    delete globalThis[HOOK];
  });
  return { ...s, owner: s.session.sessionManager.getSessionId() };
}

// Runs `fn` once the fleet extension starts its session-end wait, which it
// begins by subscribing to the registry (a scripted session has no FleetView).
function onWait(fn) {
  const registry = fleet();
  const { subscribe } = registry;
  registry.subscribe = (listener) => {
    registry.subscribe = subscribe;
    const off = subscribe(listener);
    queueMicrotask(fn);
    return off;
  };
}

test("a notice that arrives while idle starts a turn", async (t) => {
  const { session, owner } = await start(t, [echo]);
  add("a", owner);
  fleet().finish("a", "completed", "3 files", "shell job a completed: 3 files");
  await session.waitForIdle();
  assert.deepEqual(transcript(session), ["custom: shell job a completed: 3 files", "assistant: saw: shell job a completed: 3 files"]);
});

test("a notice that arrives during a turn joins it at the next step", async (t) => {
  const finishTool = (pi) =>
    pi.registerTool({
      name: "finish_job",
      label: "finish",
      description: "test",
      parameters: { type: "object", properties: {} },
      async execute() {
        fleet().finish("a", "completed", "ok", "shell job a completed");
        return { content: [{ type: "text", text: "finishing" }], details: undefined };
      },
    });
  const { session, owner } = await start(
    t,
    [() => fauxAssistantMessage(fauxToolCall("finish_job", {}), { stopReason: "toolUse" }), echo],
    { extensions: [finishTool] },
  );
  add("a", owner);
  await session.prompt("go");
  assert.deepEqual(transcript(session), [
    "user: go",
    "assistant: call finish_job",
    "tool: finishing",
    "custom: shell job a completed",
    "assistant: saw: shell job a completed",
  ]);
});

test("notices that arrive together share one turn", async (t) => {
  let runs = 0;
  const { session, owner } = await start(t, [echo, echo], { extensions: [(pi) => pi.on("agent_start", () => runs++)] });
  add("a", owner);
  add("b", owner);
  fleet().finish("a", "completed", "ok", "job a done");
  fleet().finish("b", "failed", "exit 1", "job b failed");
  await session.waitForIdle();
  assert.equal(runs, 1);
  assert.deepEqual(transcript(session), ["custom: job a done", "custom: job b failed", "assistant: saw: job b failed"]);
});

// Tests whose failure is a wait that never ends carry a timeout, so they fail by name.
const LISTING_END = "Stop what you no longer need. The session stays open until the rest finishes, and each result arrives as a notice.";

test("a run without the UI ending with work running wakes its model once, then waits for every item", { timeout: 10_000 }, async (t) => {
  const { session, owner } = await start(t, [says("started"), echo, echo, echo], {
    onSettle(n) {
      // A notice that arrives just before a settle is queued, so the run goes on without waiting.
      if (n === 2) {
        fleet().update("b", { status: "running" });
        fleet().finish("a", "completed", "built", "shell job a completed: built");
      }
      // This one arrives while the fleet extension waits.
      if (n === 3) onWait(() => fleet().finish("b", "failed", "exit 2", "shell job b failed: exit 2"));
    },
  });
  add("a", owner);
  add("b", owner, { kind: "agent", label: "scout", status: "queued" });
  fleet().now = () => 65_000;

  await session.prompt("go");
  const listing = [
    "custom: Your run is ending with work still running:",
    "- shell job a (id a): running, 1m05s",
    "- agent scout (id b): queued, 1m05s",
    LISTING_END,
  ].join("\n");
  assert.deepEqual(transcript(session), [
    "user: go",
    "assistant: started",
    listing,
    `assistant: saw: ${listing.slice("custom: ".length)}`,
    "custom: shell job a completed: built",
    "assistant: saw: shell job a completed: built",
    "custom: shell job b failed: exit 2",
    "assistant: saw: shell job b failed: exit 2",
  ]);
});

test("a result finished without a notice reaches the model as a default line", async (t) => {
  const { session, owner } = await start(t, [says("started"), says("waiting"), echo]);
  add("a", owner);
  onWait(() => {
    fleet().now = () => 7_000;
    fleet().finish("a", "failed", "exit 1");
  });
  await session.prompt("go");
  assert.deepEqual(transcript(session).slice(-2), [
    "custom: shell job a (id a) failed after 7s: exit 1",
    "assistant: saw: shell job a (id a) failed after 7s: exit 1",
  ]);
});

test("the listing keeps entries that earlier handlers added and strips control sequences", async (t) => {
  const other = { type: "custom_message", customType: "other", content: "from another extension", display: true };
  const { session, owner } = await start(t, [says("started"), says("waiting")], {
    onSettle: (n, event) => (n === 1 ? { entries: [...event.entries, other] } : undefined),
  });
  add("a", owner, { label: "sc\u001b]0;pwned\u0007out\u001b[2J\nnext" });
  onWait(() => fleet().finish("a", "stopped", "stopped", null));
  await session.prompt("go");
  assert.deepEqual(transcript(session), [
    "user: go",
    "assistant: started",
    "custom: from another extension",
    `custom: Your run is ending with work still running:\n- shell scout next (id a): running, 0s\n${LISTING_END}`,
    "assistant: waiting",
  ]);
});

test("switching or forking the session ends the wait", { timeout: 10_000 }, async (t) => {
  for (const type of ["session_before_switch", "session_before_fork"]) {
    await t.test(type, async (t) => {
      const { session, owner } = await start(t, [says("started"), says("waiting")]);
      add("a", owner);
      onWait(() => session.extensionRunner.emit({ type, reason: "new", entryId: "x" }));
      await session.prompt("go");
      assert.equal(transcript(session).at(-1), "assistant: waiting");
      assert.equal(fleet().get("a").status, "running");
    });
  }
});

test("a notice without an item snapshot renders as plain lines", async (t) => {
  const { session } = await start(t, []);
  const renderNotice = session.extensionRunner.getMessageRenderer("rig.notice");
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
  const message = { role: "custom", customType: "rig.notice", content: "a\u001b[2Jb\u0007c\nsecond", display: true };
  const lines = renderNotice(message, { expanded: false, outputPad: 0 }, theme).render(40).map((l) => l.trimEnd());
  assert.deepEqual(lines, ["ab c", "second"]);
});

test("a session waits only for the items it owns", async (t) => {
  const { session } = await start(t, [says("done")]);
  add("theirs", "another-session");
  await session.prompt("go");
  assert.deepEqual(transcript(session), ["user: go", "assistant: done"]);
});

test("an interactive session ends its run with work still running", async (t) => {
  const ui = new Proxy({}, { get: () => () => undefined });
  const { session, owner } = await start(t, [says("done")], { bindings: { uiContext: ui, mode: "rpc" } });
  add("a", owner);
  await session.prompt("go");
  assert.deepEqual(transcript(session), ["user: go", "assistant: done"]);
});
