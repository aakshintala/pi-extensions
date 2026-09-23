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

async function start(t, replies, extensions = [], bindings = {}) {
  const s = await scriptedSession(t, { replies, extensions: [BEFORE_SETTLE, FLEET, ...extensions] });
  await s.session.bindExtensions(bindings); // emits session_start, as pi does
  const registry = fleet();
  registry.now = () => 0;
  t.after(() => {
    for (const item of registry.items()) registry.finish(item.id, "stopped", "test over");
    registry.prune();
  });
  return { ...s, owner: s.session.sessionManager.getSessionId() };
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
    [finishTool],
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
  const { session, owner } = await start(t, [echo, echo], [(pi) => pi.on("agent_start", () => runs++)]);
  add("a", owner);
  add("b", owner);
  fleet().finish("a", "completed", "ok", "job a done");
  fleet().finish("b", "failed", "exit 1", "job b failed");
  await session.waitForIdle();
  assert.equal(runs, 1);
  assert.deepEqual(transcript(session), ["custom: job a done", "custom: job b failed", "assistant: saw: job b failed"]);
});

test("a run without the UI ending with work running wakes its model once, then waits for every item", async (t) => {
  // Runs ahead of the fleet extension at each settle: at the second and third it
  // finishes items once the fleet extension has started waiting.
  let settles = 0;
  const hook = Symbol.for("pi-rig.test.beforeSettle");
  globalThis[hook] = () => {
    settles++;
    if (settles === 2)
      setImmediate(() => {
        fleet().update("b", { status: "running" });
        fleet().finish("a", "completed", "built", "shell job a completed: built");
      });
    if (settles === 3) setImmediate(() => fleet().finish("b", "failed", "exit 2", "shell job b failed: exit 2"));
  };
  t.after(() => delete globalThis[hook]);
  const { session, owner } = await start(t, [says("started"), echo, echo, echo]);
  add("a", owner);
  add("b", owner, { kind: "agent", label: "scout", status: "queued" });
  fleet().now = () => 65_000;

  await session.prompt("go");
  const listing = [
    "custom: Your run is ending with work still running:",
    "- shell job a (id a): running, 1m05s",
    "- agent scout (id b): queued, 1m05s",
    "Stop what you no longer need. The session stays open until the rest finishes, and each result arrives as a notice.",
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

test("a session waits only for the items it owns", async (t) => {
  const { session } = await start(t, [says("done")]);
  add("theirs", "another-session");
  await session.prompt("go");
  assert.deepEqual(transcript(session), ["user: go", "assistant: done"]);
});

test("an interactive session ends its run with work still running", async (t) => {
  const ui = new Proxy({}, { get: () => () => undefined });
  const { session, owner } = await start(t, [says("done")], [], { uiContext: ui, mode: "rpc" });
  add("a", owner);
  await session.prompt("go");
  assert.deepEqual(transcript(session), ["user: go", "assistant: done"]);
});
