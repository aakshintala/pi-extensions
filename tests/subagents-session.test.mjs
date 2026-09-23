// Subagents core (#52) in scripted SDK sessions, which run without the UI. The parent
// is a scripted session; each child is a real Pi session the extension creates, loading
// the extensions listed in the sealed agent dir's settings.json, with replies from the
// "kid" model (tests/fixtures/subagents/kid.ts).
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension module load in plain node
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fleet } from "../shared/fleet/index.ts";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("./fixtures/subagents/kid.ts"), path("../extensions/fleet/index.ts"), path("../extensions/subagents/index.ts")];
const KID = Symbol.for("pi-rig.test.kid");
const JOB_STOPPED = Symbol.for("pi-rig.test.jobStopped");

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? `call ${c.name}`).join(""));
const lastText = (context) => textOf(context.messages.at(-1));
const says = (text) => () => fauxAssistantMessage(fauxText(text));
const calls = (...toolCalls) => () => fauxAssistantMessage(toolCalls.map(([n, a]) => fauxToolCall(n, a)), { stopReason: "toolUse" });
const spawn = (prompt, extra = {}) => ["subagent_spawn", { description: `do ${prompt}`, prompt, model: "kid/kid-1", thinking: "low", ...extra }];

/** The first user message of a child's context: its task. */
const taskOf = (context) => textOf(context.messages.find((m) => m.role === "user")).split("\n\nEnd your final message")[0];

// A promise with its resolver, for holding a child mid-run.
function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return Object.assign(p, { open });
}

/**
 * Parent session with the subagents extension. `kid(context)` answers every child
 * request. Resolves with the session, its sealed dirs and `results()`, the parent's
 * tool results.
 */
async function start(t, replies, kid) {
  globalThis[KID] = kid;
  const s = await scriptedSession(t, { replies, extensions: EXTENSIONS });
  // Children discover their extensions from the agent dir, like a real install.
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ extensions: EXTENSIONS }));
  await s.session.bindExtensions({});
  const registry = fleet();
  const now = registry.now;
  registry.now = () => 0;
  t.after(() => {
    registry.now = now;
    for (const item of registry.items()) registry.finish(item.id, "stopped", "test over", null);
    registry.prune();
    delete globalThis[KID];
    delete globalThis[JOB_STOPPED];
  });
  const results = () => s.session.messages.filter((m) => m.role === "toolResult").map((m) => [m.isError, textOf(m)]);
  const notices = () => s.session.messages.filter((m) => m.customType === "rig.notice").map(textOf);
  return { ...s, results, notices };
}

// Runs `fn` once a fleet extension starts a session-end wait, which it begins by
// subscribing to the registry (sessions without the UI have no FleetView).
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

const STATS = /^\d+ turns? · \d+ tool uses? · [\d,]+ tokens? · \$0\.0000 · 0s$/;

test("spawn rejects an unknown model or thinking level and requires both", async (t) => {
  const { session, results } = await start(t, [
    calls(
      spawn("a", { model: "kid/nope" }),
      spawn("b", { thinking: "huge" }),
      ["subagent_spawn", { description: "c", prompt: "c", thinking: "low" }],
    ),
    says("ok"),
  ], says("never"));
  await session.prompt("go");
  const r = results();
  assert.deepEqual(r.map(([e]) => e), [true, true, true]);
  assert.match(r[0][1], /^Unknown model "kid\/nope"\.$/);
  assert.match(r[1][1], /^Validation failed for tool "subagent_spawn":\n  - thinking: must be equal to one of the allowed values\n/);
  assert.match(r[2][1], /^Validation failed for tool "subagent_spawn":\n  - model: must have required properties model\n/);
  assert.equal(fleet().items().length, 0);
});

test("a parent without the UI that spawns and ends its turn gets every full result before its run ends", { timeout: 20_000 }, async (t) => {
  const { session, agentDir, results, notices } = await start(
    t,
    [calls(spawn("alpha"), spawn("beta")), says("waiting"), says("still waiting"), says("got one"), says("got both")],
    (context) => fauxAssistantMessage(fauxText(`result of ${taskOf(context)}\nline two\nSTATUS: DONE`)),
  );
  await session.prompt("go");

  const ids = results().map(([error, text]) => (assert.equal(error, false), /^Subagent (\w+) started\.$/.exec(text)[1]));
  const got = notices().filter((n) => n.startsWith("Subagent "));
  assert.equal(got.length, 2);
  for (const [i, name] of ["alpha", "beta"].entries()) {
    const notice = got.find((n) => n.includes(`result of ${name}`));
    const [head, stats, blank, ...rest] = notice.split("\n");
    assert.equal(head, `Subagent ${ids[i]} (do ${name}) completed. STATUS: DONE`);
    assert.match(stats, STATS);
    assert.equal(blank, "");
    assert.deepEqual(rest, [`result of ${name}`, "line two", "STATUS: DONE"]);
  }
  assert.equal(session.messages.at(-1).role, "assistant");

  // Each child is a saved Pi session whose first entry marks it as a child.
  const dir = join(agentDir, "sessions", session.sessionId);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 2);
  for (const f of files) {
    const [header, first] = readFileSync(join(dir, f), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(header.type, "session");
    assert.deepEqual([first.type, first.customType], ["custom", "rig.subagent"]);
    assert.ok(ids.includes(first.data.agentId));
    assert.equal(first.data.parentSessionId, session.sessionId);
  }
});

test("spawns beyond maxConcurrent (10) queue; a message to a queued one extends its prompt", { timeout: 30_000 }, async (t) => {
  const release = gate();
  const tasks = [];
  let finishedBeforeQueued;
  const { session, results, notices } = await start(
    t,
    [
      calls(...Array.from({ length: 11 }, (_, i) => spawn(`t${i}`))),
      (context) => {
        const queued = /^Subagent (\w+) queued\.$/.exec(lastText(context))[1];
        return calls(["subagent_message", { id: queued, message: "also check the docs" }])();
      },
      () => {
        release.open();
        return says("waiting")();
      },
      ...Array.from({ length: 13 }, () => says("ok")),
    ],
    async (context) => {
      tasks.push(taskOf(context));
      if (taskOf(context).startsWith("t10")) finishedBeforeQueued = fleet().items().filter((i) => i.status === "completed").length;
      await release;
      return fauxAssistantMessage(fauxText("done\nSTATUS: DONE"));
    },
  );
  await session.prompt("go");
  const r = results().map(([, text]) => text);
  assert.deepEqual(r.slice(0, 10).map((x) => x.endsWith("started.")), Array(10).fill(true));
  assert.match(r[10], /^Subagent \w+ queued\.$/);
  assert.match(r[11], /^Subagent \w+ prompt extended\.$/);
  assert.deepEqual(tasks.sort(), [...Array.from({ length: 10 }, (_, i) => `t${i}`), "t10\n\nalso check the docs"].sort());
  assert.ok(finishedBeforeQueued >= 1, `the queued child starts only once a slot frees (${finishedBeforeQueued})`);
  assert.equal(notices().filter((n) => n.startsWith("Subagent ")).length, 11);
});

test("a message steers a running child, and resumes a finished one from its saved session", { timeout: 20_000 }, async (t) => {
  const held = gate();
  const release = gate();
  const seen = [];
  let id;
  const { session, results, notices } = await start(
    t,
    [
      calls(spawn("scout")),
      (context) => {
        id = /^Subagent (\w+) started\.$/.exec(lastText(context))[1];
        return says("waiting")();
      },
      async () => {
        await held; // the child is mid-run
        release.open();
        return calls(["subagent_message", { id, message: "focus on src/" }])();
      },
      says("waiting"),
      // The child's first notice: it needs context, so answer it.
      () => calls(["subagent_message", { id, message: "use the main branch" }])(),
      says("waiting again"),
      says("thanks"),
    ],
    async (context) => {
      seen.push(context.messages.filter((m) => m.role === "user").map(textOf).map((x) => x.split("\n\nEnd your")[0]));
      if (seen.length === 1) {
        held.open();
        await release;
        return calls(["read", { path: "notes.txt" }])();
      }
      if (seen.length === 2) return fauxAssistantMessage(fauxText("which branch?\nSTATUS: NEEDS_CONTEXT"));
      return fauxAssistantMessage(fauxText("checked main\nSTATUS: DONE"));
    },
  );
  await session.prompt("go");

  assert.deepEqual(results().map(([e, text]) => [e, text.replace(id, "ID")]), [
    [false, "Subagent ID started."],
    [false, "Subagent ID steered."],
    [false, "Subagent ID resumed."],
  ]);
  // The steer reached the running child; the resume carried its whole history.
  assert.deepEqual(seen[1], ["scout", "focus on src/"]);
  assert.deepEqual(seen[2], ["scout", "focus on src/", "use the main branch"]);
  const got = notices().filter((n) => n.startsWith("Subagent "));
  assert.deepEqual(got.map((n) => n.split("\n")[0]), [
    `Subagent ${id} (do scout) completed. STATUS: NEEDS_CONTEXT`,
    `Subagent ${id} (do scout) completed. STATUS: DONE`,
  ]);
});

test("stop ends a child waiting on its own work, with its partial output marked incomplete", { timeout: 20_000 }, async (t) => {
  const stopped = [];
  const waiting = gate();
  let id;
  const { session, results, notices } = await start(
    t,
    [
      calls(spawn("builder")),
      (context) => {
        id = /^Subagent (\w+) started\.$/.exec(lastText(context))[1];
        return says("waiting")();
      },
      // The child is now waiting on its job (see the kid below): stop it.
      async () => {
        await waiting;
        return calls(["subagent_stop", { id }])();
      },
      says("stopped it"),
      says("noted"),
    ],
    (context) => {
      const last = context.messages.at(-1);
      if (last.role === "toolResult") return fauxAssistantMessage(fauxText("half the build log"));
      if (!lastText(context).startsWith("Your run is ending")) return calls(["start_job", { id: "build" }])();
      onWait(() => waiting.open());
      return fauxAssistantMessage(fauxText("still waiting on the build"));
    },
  );
  globalThis[JOB_STOPPED] = (job) => stopped.push(job); // leaves the job running: only the shutdown ends the wait
  await session.prompt("go");

  assert.deepEqual(stopped, ["build"]);
  assert.deepEqual(results().map(([e, text]) => [e, text.replace(id, "ID")]), [
    [false, "Subagent ID started."],
    [false, "Subagent ID stopped."],
  ]);
  const notice = notices().find((n) => n.startsWith(`Subagent ${id}`));
  const [head, stats, , ...rest] = notice.split("\n");
  assert.equal(head, `Subagent ${id} (do builder) stopped. STATUS: STOPPED`);
  assert.match(stats, STATS);
  assert.equal(rest.join("\n"), "Partial output, incomplete:\nstill waiting on the build");
  assert.equal(fleet().get(id).status, "stopped");
});

test("a result above the inline limit goes to a file beside the child's session", { timeout: 20_000 }, async (t) => {
  const big = Array.from({ length: 2000 }, (_, i) => `finding ${i}`).join("\n") + "\nSTATUS: DONE_WITH_CONCERNS";
  const { session, notices } = await start(t, [calls(spawn("review")), says("waiting"), says("waiting"), says("read it")], says(big));
  await session.prompt("go");
  const notice = notices().find((n) => n.startsWith("Subagent "));
  const [head, , , filed, begins, ...lead] = notice.split("\n");
  assert.match(head, /^Subagent \w+ \(do review\) completed\. STATUS: DONE_WITH_CONCERNS$/);
  const [, chars, file] = /^Full result \(([\d,]+) characters\): (.+)$/.exec(filed);
  assert.equal(chars, big.length.toLocaleString("en-US"));
  assert.equal(readFileSync(file, "utf8"), big);
  assert.ok(existsSync(file.replace(/\.result\.md$/, "")) || readdirSync(join(file, "..")).some((f) => f.endsWith(".jsonl")));
  assert.equal(begins, "It begins:");
  assert.equal(lead.join("\n"), big.slice(0, 1000));
});

test("stop works on a queued child and on one mid-reply; a failed child reports its error", { timeout: 20_000 }, async (t) => {
  const held = gate();
  const release = gate();
  const ids = {};
  const { session, results, notices } = await start(
    t,
    [
      calls(spawn("broken"), ...Array.from({ length: 10 }, (_, i) => spawn(`slow${i}`))),
      (context) => {
        const r = context.messages.filter((m) => m.role === "toolResult").map(textOf);
        ids.broken = /^Subagent (\w+)/.exec(r[0])[1];
        ids.slow = /^Subagent (\w+)/.exec(r[1])[1];
        return says("waiting")();
      },
      async () => {
        await held; // slow0 is mid-reply and one of the ten slow ones is still queued
        const queued = fleet().items().find((i) => i.status === "queued" && i.owner === session.sessionId).id;
        ids.queued = queued;
        return calls(["subagent_stop", { id: ids.slow }], ["subagent_stop", { id: queued }])();
      },
      () => {
        release.open();
        return says("stopped two")();
      },
      ...Array.from({ length: 12 }, () => says("ok")),
    ],
    async (context) => {
      const task = taskOf(context);
      if (task === "slow0") held.open();
      await release;
      if (task === "broken") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "quota exceeded" });
      return fauxAssistantMessage(fauxText("partial"));
    },
  );
  await session.prompt("go");
  const byId = (id) => notices().find((n) => n.startsWith(`Subagent ${id} `));
  assert.match(byId(ids.broken), /^Subagent \w+ \(do broken\) failed\. STATUS: FAILED\n.+\n\nError: quota exceeded$/);
  assert.match(byId(ids.queued), /^Subagent \w+ \(do slow\d\) stopped before it started\.$/);
  assert.match(byId(ids.slow), /^Subagent \w+ \(do slow0\) stopped\. STATUS: STOPPED\n.+\n\nNo output\.$/);
  assert.deepEqual(results().slice(11).map(([, text]) => text), [`Subagent ${ids.slow} stopped.`, `Subagent ${ids.queued} stopped.`]);
});

test("a child gets none of the subagent tools", { timeout: 20_000 }, async (t) => {
  let tools;
  const { session } = await start(t, [calls(spawn("look")), says("waiting"), says("waiting"), says("ok")], (context) => {
    tools = getCurrentTools(context.messages).map((tool) => tool.name);
    return says("done")();
  });
  await session.prompt("go");
  assert.ok(tools.includes("read"));
  assert.deepEqual(tools.filter((name) => name.startsWith("subagent_")), []);
});

test("the parent's shutdown stops its running children and shuts each down", { timeout: 20_000 }, async (t) => {
  const held = gate();
  const shut = (globalThis[Symbol.for("pi-rig.test.kidShutdown")] = []);
  t.after(() => delete globalThis[Symbol.for("pi-rig.test.kidShutdown")]);
  let id;
  const { session, results } = await start(t, [calls(spawn("long")), says("started")], (_context, options) => {
    held.open();
    // Answers only when aborted, as a provider does.
    return new Promise((resolve) =>
      options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" }))),
    );
  });
  const ui = new Proxy({}, { get: () => () => undefined });
  await session.bindExtensions({ uiContext: ui, mode: "rpc" }); // with a UI the run ends at once
  await session.prompt("go");
  id = /^Subagent (\w+)/.exec(results()[0][1])[1];
  await held;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(fleet().get(id).status, "stopped");
  assert.equal(shut.filter((s) => s !== session.sessionId).length, 1);
});

test("with enabledModels set, the model parameter is an enum of them and nothing else is accepted", async (t) => {
  await scriptedSession(t); // only for its sealed agent dir
  const tools = new Map();
  const handlers = {};
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => (handlers[event] = handler),
    getActiveTools: () => [],
    setActiveTools() {},
  };
  const { default: subagents } = await import("../extensions/subagents/index.ts");
  subagents(pi);
  const model = (provider, id) => ({ model: { provider, id } });
  const ctx = {
    scopedModels: [model("a", "one"), model("b", "two"), model("a", "one")],
    sessionManager: { getEntries: () => [], getSessionId: () => "p" },
    modelRegistry: { getAll: () => [model("c", "three").model] },
  };
  handlers.session_start({}, ctx);
  const spawnTool = tools.get("subagent_spawn");
  assert.deepEqual(spawnTool.parameters.properties.model.enum, ["a/one", "b/two"]);
  await assert.rejects(
    spawnTool.execute("x", { description: "d", prompt: "p", model: "c/three", thinking: "low" }, undefined, undefined, ctx),
    { message: 'Unknown model "c/three". Use one of: a/one, b/two.' },
  );
});
