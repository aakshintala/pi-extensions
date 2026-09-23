// Subagents core (#52) and nesting (#53) in scripted SDK sessions, which run without the UI. The parent
// is a scripted session; each child is a real Pi session the extension creates, loading
// the extensions listed in the sealed agent dir's settings.json, with replies from the
// "kid" model (tests/fixtures/subagents/kid.ts).
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension module load in plain node
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { fleet } from "../shared/fleet/index.ts";
import { rigSettings } from "../shared/settings/index.ts";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("./fixtures/subagents/kid.ts"), path("../extensions/fleet/index.ts"), path("../extensions/subagents/index.ts")];
const KID = Symbol.for("pi-rig.test.kid");
const PRICE = Symbol.for("pi-rig.test.kidPrice");
const JOB_STARTED = Symbol.for("pi-rig.test.jobStarted");
const SUBAGENT_TOOLS = ["subagent_spawn", "subagent_message", "subagent_stop"];
const JOB_STOPPED = Symbol.for("pi-rig.test.jobStopped");
const RUNTIME = Symbol.for("pi-rig.subagents.modelRuntime");

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
 * Parent session with the subagents extension. `kid(context, options)` answers every
 * child request. `tools` is the parent's tool allowlist; `before(session)` runs before
 * session_start. Resolves with the session, its sealed dirs, `ctx` (the parent's
 * extension context), `results()` (its tool results) and `notices()`.
 */
async function start(t, replies, kid, { tools, before } = {}) {
  globalThis[KID] = kid;
  let ctx;
  const capture = (pi) => pi.on("session_start", (_event, c) => (ctx = c));
  const s = await scriptedSession(t, { replies, extensions: [...EXTENSIONS, capture], tools });
  globalThis[RUNTIME] = s.session.modelRuntime; // children share it, so none writes auth.json (#120)
  // Children discover their extensions from the agent dir, like a real install.
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ extensions: EXTENSIONS }));
  await before?.(s.session);
  await s.session.bindExtensions({});
  const registry = fleet();
  const now = registry.now;
  registry.now = () => 0;
  t.after(() => {
    registry.now = now;
    for (const item of registry.items()) registry.finish(item.id, "stopped", "test over", null);
    registry.prune();
    delete globalThis[KID];
    delete globalThis[RUNTIME];
    delete globalThis[JOB_STOPPED];
    delete globalThis[JOB_STARTED];
    delete globalThis[PRICE];
  });
  const results = () => s.session.messages.filter((m) => m.role === "toolResult").map((m) => [m.isError, textOf(m)]);
  const notices = () => s.session.messages.filter((m) => m.customType === "rig.notice").map(textOf);
  return { ...s, ctx, results, notices };
}

/** A second, fresh instance of the subagents extension, as after a restart; `tools` maps names to definitions. */
async function freshInstance() {
  const tools = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on() {},
    getActiveTools: () => ["read", ...SUBAGENT_TOOLS],
    setActiveTools() {},
    sendMessage() {},
  };
  const { default: subagents } = await import("../extensions/subagents/index.ts");
  subagents(pi);
  const call = (name, params, ctx) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  return { tools, call };
}

/** `ctx` as another session would see it: the same everything but its session id. */
const asSession = (ctx, id) => ({
  ...ctx,
  cwd: ctx.cwd,
  scopedModels: ctx.scopedModels,
  modelRegistry: ctx.modelRegistry,
  sessionManager: new Proxy(ctx.sessionManager, { get: (sm, k) => (k === "getSessionId" ? () => id : sm[k].bind(sm)) }),
});

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

/**
 * Sets a `subagents` rig.json setting for this test; call after start(). The settings
 * instance is per process, so its file may be in an earlier test's removed dir: that dir
 * is removed again afterwards (the reset runs after the session's own cleanup).
 */
function setting(t, key, value) {
  const rig = rigSettings("");
  const section = rig.sections().find((s) => s.name === "subagents");
  section.set(key, value);
  t.after(() => {
    section.reset(key);
    const box = dirname(dirname(rig.path));
    if (basename(box).startsWith("pi-rig-session-") && !existsSync(join(box, "cwd"))) rmSync(box, { recursive: true, force: true });
  });
}

const idOf = (label) => fleet().items().find((i) => i.label === `do ${label}`)?.id;
const noticed = (context, label, status = "completed") => context.messages.some((m) => m.role !== "assistant" && m.role !== "toolResult" && textOf(m).includes(`(do ${label}) ${status}`));
/** Answers only when aborted, as a provider does. */
const untilAborted = (options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" }))));

const tokens = (line) => Number(/ · ([\d,]+) tokens? · /.exec(line)[1].replace(/,/g, ""));
const cost = (line) => /tokens? · (\$[\d.]+)/.exec(line)[1];
const { money } = await import("../extensions/subagents/index.ts");

const STATS = /^\d+ turns? · \d+ tool uses? · [\d,]+ tokens? · \$0\.00 · 0s$/;

test("spawn rejects an unknown model or thinking level and requires both", async (t) => {
  const { session, results } = await start(t, [
    calls(
      spawn("a", { model: "kid/nope" }),
      spawn("b", { thinking: "huge" }),
      ["subagent_spawn", { description: "c", prompt: "c", thinking: "low" }],
      spawn("d", { thinking: "xhigh" }),
      spawn("e", { model: "faux/faux-1" }),
    ),
    says("ok"),
  ], says("never"));
  await session.prompt("go");
  const r = results();
  assert.deepEqual(r.map(([e]) => e), [true, true, true, true, true]);
  assert.match(r[0][1], /^Unknown model "kid\/nope"\.$/);
  assert.match(r[1][1], /^Validation failed for tool "subagent_spawn":\n  - thinking: must be equal to one of the allowed values\n/);
  assert.match(r[2][1], /^Validation failed for tool "subagent_spawn":\n  - model: must have required properties model\n/);
  // Pi would clamp these silently: xhigh above what kid-1 offers, any thinking on a model without it.
  assert.equal(r[3][1], 'kid/kid-1 cannot think at "xhigh". Use one of: off, minimal, low, medium, high.');
  assert.equal(r[4][1], 'faux/faux-1 cannot think at "low". Use one of: off.');
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
        return calls(["subagent_message", { id, message: "/kidcmd focus on src/" }])();
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
  // A steer is literal text, like every other message: a command name is not run.
  assert.deepEqual(seen[1], ["scout", "/kidcmd focus on src/"]);
  assert.deepEqual(seen[2], ["scout", "/kidcmd focus on src/", "use the main branch"]);
  const got = notices().filter((n) => n.startsWith("Subagent "));
  assert.deepEqual(got.map((n) => n.split("\n")[0]), [
    `Subagent ${id} (do scout) completed. STATUS: NEEDS_CONTEXT`,
    `Subagent ${id} (do scout) completed. STATUS: DONE`,
  ]);
  // The resumed run's notice gives that run, then the session's totals over both runs.
  const [, run, total] = got[1].split("\n");
  assert.match(run, /^1 turn · 0 tool uses · [\d,]+ tokens · \$0\.00 · 0s$/);
  assert.match(total, /^Session total: 3 turns · 1 tool use · [\d,]+ tokens · \$0\.00$/);
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

test("with maxDepth 1, a child gets none of the subagent tools", { timeout: 20_000 }, async (t) => {
  let tools;
  const { session } = await start(t, [calls(spawn("look")), says("waiting"), says("waiting"), says("ok")], (context) => {
    tools = getCurrentTools(context.messages).map((tool) => tool.name);
    return says("done")();
  });
  setting(t, "maxDepth", 1);
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
  // The fleet has already detached this session, so the notice is saved in it directly.
  const saved = session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "rig.notice");
  assert.equal(saved.length, 1);
  assert.match(saved[0].content, new RegExp(`^Subagent ${id} \\(do long\\) stopped\\. STATUS: STOPPED\n`));
  assert.equal(saved[0].details.status, "stopped");
});

test("with enabledModels set, subagent_spawn is replaced by one whose model is an enum of them", { timeout: 20_000 }, async (t) => {
  let kid;
  const { session, results } = await start(t, [calls(spawn("x", { model: "faux/faux-1", thinking: "off" })), says("ok")], says("never"), {
    before(session) {
      kid = session.modelRuntime.getModel("kid", "kid-1");
      session.setScopedModels([{ model: kid }, { model: kid }]);
    },
  });
  // Pi keeps one definition per tool name, so the scoped registration replaces the base one.
  const spawns = session.getAllTools().filter((tool) => tool.name === "subagent_spawn");
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].parameters.properties.model, { type: "string", enum: ["kid/kid-1"] });
  await session.prompt("go");
  assert.match(results()[0][1], /^Validation failed for tool "subagent_spawn":\n  - model: must be equal to one of the allowed values\n/);
});

test("costs below a cent keep two significant digits", async () => {
  const { money } = await import("../extensions/subagents/index.ts");
  assert.deepEqual([0, 0.00003, 0.000314, 0.0312, 1.5].map(money), ["$0.00", "$0.000030", "$0.00031", "$0.03", "$1.50"]);
});

test("a result that cannot be filed is sent inline, truncated, and the parent's run still ends", { timeout: 20_000 }, async (t) => {
  const big = "x".repeat(20_000) + "\nSTATUS: DONE";
  const s = await start(t, [calls(spawn("review")), says("waiting"), says("waiting"), says("read it")], (_context, options) => {
    // A directory where the result file goes: the rename onto it fails.
    mkdirSync(join(s.agentDir, "sessions", s.session.sessionId, `${options.sessionId}.result.md`, "blocker"), { recursive: true });
    return says(big)();
  });
  await s.session.prompt("go");
  const notice = s.notices().find((n) => n.startsWith("Subagent "));
  const [head, , , cause, ...rest] = notice.split("\n");
  assert.match(head, /^Subagent \w+ \(do review\) completed\. STATUS: DONE$/);
  assert.match(cause, /^Could not save the full result \(.+\)\. Truncated to its first 16,000 characters:$/);
  assert.equal(rest.join("\n"), big.slice(0, 16_000));
  assert.equal(s.session.messages.at(-1).role, "assistant");
});

test("after a restart, a message resumes a saved child from its session file", { timeout: 20_000 }, async (t) => {
  const seen = [];
  const tools = [];
  let id;
  const { session, ctx, agentDir, notices } = await start(
    t,
    [calls(spawn("scout")), (context) => ((id = /^Subagent (\w+)/.exec(lastText(context))[1]), says("waiting")()), says("waiting"), says("got it"), says("got it again")],
    (context) => {
      seen.push(context.messages.filter((m) => m.role === "user").map((m) => textOf(m).split("\n\nEnd your")[0]));
      tools.push(getCurrentTools(context.messages).map((tool) => tool.name).filter((name) => name.startsWith("subagent_")));
      return says(seen.length === 1 ? "first\nSTATUS: NEEDS_CONTEXT" : "second\nSTATUS: DONE")();
    },
  );
  await session.prompt("go");

  // A new extension instance knows nothing in memory; it finds the child on disk.
  const fresh = await freshInstance();
  const resumed = await fresh.call("subagent_message", { id, message: "here is the context" }, ctx);
  assert.equal(resumed.content[0].text, `Subagent ${id} resumed.`);
  await new Promise((resolve) => {
    const off = fleet().subscribe(() => fleet().get(id)?.status === "completed" && (off(), resolve()));
  });
  await session.waitForIdle();
  assert.deepEqual(seen[1], ["scout", "here is the context"]);
  // The child's depth is saved in its first entry, and a depth-1 child reopened after a restart keeps its tools.
  const dir = join(agentDir, "sessions", session.sessionId);
  const [, marker] = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`))), "utf8").split("\n").map((l) => l && JSON.parse(l));
  assert.deepEqual(marker.data, { agentId: id, parentSessionId: session.sessionId, depth: 1 });
  assert.deepEqual(tools, [SUBAGENT_TOOLS, SUBAGENT_TOOLS]);
  assert.deepEqual(notices().filter((n) => n.startsWith("Subagent ")).map((n) => n.split("\n")[0]), [
    `Subagent ${id} (do scout) completed. STATUS: NEEDS_CONTEXT`,
    `Subagent ${id} (do scout) completed. STATUS: DONE`,
  ]);
});

test("only the session that spawned a child can message or stop it", { timeout: 20_000 }, async (t) => {
  const held = gate();
  const { ctx } = await start(t, [], (_context, options) => {
    held.open();
    return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" }))));
  });
  const { call } = await freshInstance();
  const started = await call("subagent_spawn", { description: "mine", prompt: "p", model: "kid/kid-1", thinking: "low" }, ctx);
  const id = started.details.id;
  await held;
  const other = asSession(ctx, "someone-else");
  await assert.rejects(call("subagent_message", { id, message: "hi" }, other), { message: `No subagent ${id} of yours. Use an id that your subagent_spawn returned.` });
  await assert.rejects(call("subagent_stop", { id }, other), { message: `No subagent ${id} below you.` });
  assert.equal((await call("subagent_stop", { id }, ctx)).content[0].text, `Subagent ${id} stopped.`);
});

test("stop waits for the child's own work to stop before shutting it down, but not forever", { timeout: 20_000 }, async (t) => {
  const shut = (globalThis[Symbol.for("pi-rig.test.kidShutdown")] = []);
  t.after(() => delete globalThis[Symbol.for("pi-rig.test.kidShutdown")]);
  const waiting = gate();
  const shutWhenStopped = {};
  let id;
  const { session } = await start(
    t,
    [
      calls(spawn("builder")),
      (context) => ((id = /^Subagent (\w+)/.exec(lastText(context))[1]), says("waiting")()),
      async () => (await waiting, calls(["subagent_stop", { id }])()),
      says("stopped"),
      says("noted"),
    ],
    (context) => {
      if (context.messages.at(-1).role === "toolResult") return says("jobs started")();
      if (!lastText(context).startsWith("Your run is ending")) return calls(["start_job", { id: "slow" }], ["start_job", { id: "stuck" }])();
      onWait(() => waiting.open());
      return says("waiting on jobs")();
    },
  );
  globalThis[JOB_STOPPED] = (job) =>
    job === "slow"
      ? new Promise((resolve) => setImmediate(() => ((shutWhenStopped.slow = shut.length), resolve())))
      : new Promise(() => {}); // never stops: the wait is bounded
  await session.prompt("go");
  assert.equal(shutWhenStopped.slow, 0, "the child shut down only after its job stopped");
  assert.equal(shut.length, 1);
  assert.equal(fleet().get(id).status, "stopped");
});

test("a child inherits the parent's active tools and prompt sections", { timeout: 20_000 }, async (t) => {
  const PROMPT = Symbol.for("pi-rig.test.parentPrompt");
  globalThis[PROMPT] = {
    customPrompt: "PARENT CUSTOM PROMPT",
    appendSystemPrompt: "PARENT APPENDED",
    contextFiles: [{ path: "/parent/AGENTS.md", content: "PARENT RULES" }],
  };
  t.after(() => delete globalThis[PROMPT]);
  let child;
  const { session } = await start(
    t,
    [calls(spawn("look")), says("waiting"), says("waiting"), says("ok")],
    (context) => {
      child = { tools: getCurrentTools(context.messages).map((tool) => tool.name).sort(), prompt: getCurrentSystemPrompt(context.messages) };
      return says("done")();
    },
    { tools: ["read", "ls", ...["subagent_spawn", "subagent_message", "subagent_stop"]] },
  );
  await session.prompt("go");
  assert.deepEqual(child.tools, ["ls", "read", "subagent_message", "subagent_spawn", "subagent_stop"]);
  assert.match(child.prompt, /^PARENT CUSTOM PROMPT/);
  for (const text of ["PARENT APPENDED", "PARENT RULES"]) assert.ok(child.prompt.includes(text), text);
});

test("a child ending with a grandchild running is woken once, and its notice, counting the grandchild's tokens, comes after", { timeout: 20_000 }, async (t) => {
  const listed = gate();
  const tools = {};
  const child = {};
  let grandDoneAtNotice;
  const root = (context) => {
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("C"))();
    if (noticed(context, "C")) grandDoneAtNotice = fleet().get(idOf("G")).status;
    return says("waiting")();
  };
  globalThis[PRICE] = 1e-6;
  const { session, agentDir, notices } = await start(t, Array(6).fill(root), async (context, options) => {
    const task = taskOf(context);
    tools[task] = getCurrentTools(context.messages).map((tool) => tool.name).filter((name) => name.startsWith("subagent_"));
    if (task === "G") {
      await listed;
      return says("G result\nSTATUS: DONE")();
    }
    child.id = options.sessionId;
    child.context = context;
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("G"))();
    if (lastText(context).startsWith("Your run is ending")) {
      listed.open();
      return says("still waiting on G")();
    }
    if (noticed(context, "G")) return says("C done\nSTATUS: DONE")();
    return says("waiting on G")();
  });
  await session.prompt("go");

  // Depth 1 keeps the tools; depth 2, the default maxDepth, has none.
  assert.deepEqual(tools.C, ["subagent_spawn", "subagent_message", "subagent_stop"]);
  assert.deepEqual(tools.G, []);
  // The grandchild is shown under its parent.
  assert.equal(fleet().get(idOf("G")).parentId, child.id);
  // Woken once with the list, then continued by the grandchild's notice.
  const users = child.context.messages.filter((m) => m.role !== "assistant" && m.role !== "toolResult").map(textOf);
  assert.equal(users.filter((u) => u.startsWith("Your run is ending")).length, 1);
  assert.ok(noticed(child.context, "G"));
  assert.equal(grandDoneAtNotice, "completed");
  const notice = notices().find((n) => n.startsWith(`Subagent ${child.id} `));
  assert.match(notice, /\n\nC done\nSTATUS: DONE$/);

  // Tokens roll up: the child's count is its own replies plus the grandchild's count.
  const grand = users.find((u) => u.startsWith(`Subagent ${idOf("G")} `));
  const dir = join(agentDir, "sessions", session.sessionId);
  const file = readdirSync(dir).find((f) => f.endsWith(`_${child.id}.jsonl`));
  const own = readFileSync(join(dir, file), "utf8").trim().split("\n").map(JSON.parse)
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .reduce((n, e) => n + e.message.usage.totalTokens, 0);
  assert.ok(tokens(grand) > 0);
  assert.equal(tokens(notice), own + tokens(grand));
  // Cost rolls up the same way: every reply costs $0.000001 a token.
  assert.equal(cost(notice), money(tokens(notice) * 1e-6));
});

test("nested children take no queue slot, and a nested spawn over maxSessions is refused", { timeout: 20_000 }, async (t) => {
  const bothRunning = gate();
  const tried = gate();
  const started = new Set();
  let refusal;
  const root = (context) => (context.messages.some((m) => m.role === "toolResult") ? says("waiting")() : calls(spawn("C"))());
  const { session, notices } = await start(t, Array(6).fill(root), async (context) => {
    const task = taskOf(context);
    if (task !== "C") {
      started.add(task);
      if (started.size === 2) bothRunning.open();
      await tried; // both run until C has tried a third
      return says(`${task} done`)();
    }
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (!results.length) return calls(spawn("G1"), spawn("G2"))();
    if (results.length === 2) {
      await bothRunning; // the only top-level slot is C's, yet both grandchildren run
      return calls(spawn("G3"))();
    }
    if (results.length === 3 && context.messages.at(-1).role === "toolResult") {
      refusal = [results[2].isError, textOf(results[2])];
      tried.open();
    }
    return says("C done")();
  });
  setting(t, "maxConcurrent", 1);
  setting(t, "maxSessions", 4); // root, C, G1 and G2
  await session.prompt("go");
  assert.deepEqual(refusal, [true, "Refused: your tree of agents already runs 4 sessions, the most allowed. Wait for one to finish or stop one."]);
  assert.deepEqual([...started].sort(), ["G1", "G2"]);
  assert.equal(idOf("G3"), undefined);
  assert.match(notices().find((n) => n.includes("(do C)")), /completed/);
});

test("stop reaches any descendant and cascades down the chain; a stop outside the caller's subtree is refused", { timeout: 20_000 }, async (t) => {
  const grandsRunning = gate();
  const running = new Set();
  let refusal;
  let step = 0;
  const root = (context) => {
    if (step === 0) return step++, calls(spawn("A"), spawn("B"))();
    if (step === 1 && noticed(context, "B")) return step++, calls(["subagent_stop", { id: idOf("A1") }])();
    if (step === 2) return step++, calls(["subagent_stop", { id: idOf("A") }])();
    return says("waiting")();
  };
  const { session, results, notices } = await start(t, Array(12).fill(root), async (context, options) => {
    const task = taskOf(context);
    if (task === "A1" || task === "A2") {
      running.add(task);
      if (running.size === 2) grandsRunning.open();
      return untilAborted(options);
    }
    const last = context.messages.at(-1);
    if (task === "A") return last.role === "user" && !noticed(context, "A1", "stopped") && !lastText(context).startsWith("Your run") ? calls(spawn("A1"), spawn("A2"))() : says("waiting")();
    // B: tries to stop its sibling's child.
    if (last.role !== "toolResult") {
      await grandsRunning;
      return calls(["subagent_stop", { id: idOf("A1") }])();
    }
    refusal = [last.isError, textOf(last)];
    return says("B done\nSTATUS: DONE")();
  });
  await session.prompt("go");
  const [a, a1, a2] = ["A", "A1", "A2"].map(idOf);
  assert.deepEqual(refusal, [true, `No subagent ${a1} below you.`]);
  assert.deepEqual(results().slice(2).map(([e, text]) => [e, text]), [[false, `Subagent ${a1} stopped.`], [false, `Subagent ${a} stopped.`]]);
  assert.deepEqual([a, a1, a2].map((id) => fleet().get(id).status), ["stopped", "stopped", "stopped"]);
  assert.match(notices().find((n) => n.startsWith(`Subagent ${a} `)), /^Subagent \w+ \(do A\) stopped\. STATUS: STOPPED\n/);
});

test("a top-level spawn queues while the tree is at maxSessions, and starts when room frees", { timeout: 20_000 }, async (t) => {
  const { session, results, notices } = await start(t, [calls(spawn("one"), spawn("two")), ...Array(5).fill(says("waiting"))], says("done\nSTATUS: DONE"));
  setting(t, "maxSessions", 2); // the root and one agent
  await session.prompt("go");
  assert.deepEqual(results().map(([, text]) => text.replace(/ \w{8} /, " ID ")), ["Subagent ID started.", "Subagent ID queued."]);
  assert.equal(notices().filter((n) => / completed\. STATUS: DONE\n/.test(n)).length, 2);
});

test("with enabledModels set, a child's subagent_spawn offers only them too", { timeout: 20_000 }, async (t) => {
  let model;
  const { session } = await start(t, [calls(spawn("look")), says("waiting"), says("waiting"), says("ok")], (context) => {
    model = getCurrentTools(context.messages).find((tool) => tool.name === "subagent_spawn")?.parameters.properties.model;
    return says("done")();
  }, {
    before(session) {
      session.setScopedModels([{ model: session.modelRuntime.getModel("kid", "kid-1") }]);
    },
  });
  await session.prompt("go");
  assert.deepEqual(model, { type: "string", enum: ["kid/kid-1"] });
});

test("a nested agent finishing frees room for a queued top-level spawn", { timeout: 20_000 }, async (t) => {
  const [gRunning, dQueued, dStarted] = [gate(), gate(), gate()];
  let cAtD;
  const root = async (context) => {
    const results = context.messages.filter((m) => m.role === "toolResult").map(textOf);
    if (!results.length) return calls(spawn("C"))();
    if (results.length === 1) return (await gRunning, calls(spawn("D"))());
    if (/queued\.$/.test(results[1])) dQueued.open();
    return says("waiting")();
  };
  const { session, results } = await start(t, Array(8).fill(root), async (context) => {
    const task = taskOf(context);
    if (task === "G") return (gRunning.open(), await dQueued, says("G done")());
    if (task === "D") return (cAtD = fleet().get(idOf("C")).status, dStarted.open(), says("D done")());
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("G"))();
    if (noticed(context, "G")) return (await dStarted, says("C done")());
    return says("waiting")();
  });
  setting(t, "maxSessions", 3); // the root, C and G
  await session.prompt("go");
  assert.match(results()[1][1], /^Subagent \w+ queued\.$/);
  assert.equal(cAtD, "running");
});

test("tokens and cost roll up across a resumed nested run, and Session total counts every child's run", { timeout: 20_000 }, async (t) => {
  let g, cContext;
  let asked = false;
  const root = (context) => {
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("C"))();
    if (noticed(context, "C") && !asked) return (asked = true), calls(["subagent_message", { id: idOf("C"), message: "again" }])();
    return says("waiting")();
  };
  globalThis[PRICE] = 1e-6;
  const { session, agentDir, notices } = await start(t, Array(12).fill(root), (context, options) => {
    if (taskOf(context) === "G") return (g = options.sessionId), says("G\nSTATUS: DONE")();
    cContext = context;
    const users = context.messages.filter((m) => m.role === "user").map(textOf);
    const heard = users.filter((u) => u.startsWith(`Subagent ${g} `)).length;
    const second = users.some((u) => u.startsWith("again"));
    if (!second) {
      if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("G"))();
      return says(heard ? "C one\nSTATUS: DONE" : "waiting")();
    }
    if (textOf(context.messages.at(-1)).startsWith("again")) return calls(["subagent_message", { id: g, message: "more" }])();
    return says(heard === 2 ? "C two\nSTATUS: DONE" : "waiting")();
  });
  await session.prompt("go");

  const c = idOf("C");
  const second = notices().filter((n) => n.startsWith(`Subagent ${c} `))[1];
  assert.match(second, /\n\nC two\nSTATUS: DONE$/);
  const [, run, total] = second.split("\n");
  const grand = cContext.messages.filter((m) => m.role === "user").map(textOf).filter((u) => u.startsWith(`Subagent ${g} `)).map((u) => tokens(u.split("\n")[1]));
  // C's own replies, from its saved session, split at the resume.
  const dir = join(agentDir, "sessions", session.sessionId);
  const entries = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(`_${c}.jsonl`))), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.type === "message");
  const resumedAt = entries.findIndex((e) => e.message.role === "user" && textOf(e.message).startsWith("again"));
  const own = (list) => list.filter((e) => e.message.role === "assistant").reduce((n, e) => n + e.message.usage.totalTokens, 0);
  assert.equal(grand.length, 2);
  assert.equal(tokens(run), own(entries.slice(resumedAt)) + grand[1]);
  assert.equal(tokens(total), own(entries) + grand[0] + grand[1]);
  assert.equal(cost(run), money(tokens(run) * 1e-6));
  assert.equal(cost(total), money(tokens(total) * 1e-6));
});

test("a stopped agent leaves the tree's cap at once, even while it winds down", { timeout: 20_000 }, async (t) => {
  const [g1Running, release] = [gate(), gate()];
  let second;
  const root = (context) => (context.messages.some((m) => m.role === "toolResult") ? says("waiting")() : calls(spawn("C"))());
  const { session } = await start(t, Array(6).fill(root), async (context) => {
    const task = taskOf(context);
    if (task === "G1") return g1Running.open(), await release, says("late")(); // ignores its abort
    if (task === "G2") return release.open(), says("G2 done")();
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (!results.length) return calls(spawn("G1"))();
    if (results.length === 1) return await g1Running, calls(["subagent_stop", { id: idOf("G1") }])();
    if (results.length === 2) return calls(spawn("G2"))();
    if (results.length === 3 && context.messages.at(-1).role === "toolResult") second = [results[2].isError, textOf(results[2])];
    return says("C done")();
  });
  setting(t, "maxSessions", 3); // the root, C and one more
  await session.prompt("go");
  assert.deepEqual(second, [false, `Subagent ${idOf("G2")} started.`]);
});

test("an agent being stopped cannot start anything below it", { timeout: 20_000 }, async (t) => {
  let attempt;
  const gDone = new Promise((resolve) => {
    const off = fleet().subscribe(() => fleet().get(idOf("G") ?? "")?.status === "completed" && (off(), resolve()));
  });
  const root = async (context) => {
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("C"))();
    if (context.messages.filter((m) => m.role === "toolResult").length === 1) return await gDone, calls(["subagent_stop", { id: idOf("C") }])();
    return says("ok")();
  };
  const { session } = await start(t, Array(6).fill(root), (context) => {
    if (taskOf(context) === "G") return says("G done")();
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(["start_job", { id: "hold" }], spawn("G"))();
    return says("waiting")(); // the job keeps C alive
  });
  // Mid-stop, while C's job is being stopped, the user resumes C's finished child from FleetView.
  globalThis[JOB_STOPPED] = () =>
    fleet().get(idOf("G")).steer("again").then(() => (attempt = "resumed"), (e) => (attempt = e.message));
  await session.prompt("go");
  assert.equal(attempt, "Refused: you are being stopped.");
});

test("the parent's shutdown gives up on a child that will not stop, after a bound", { timeout: 30_000 }, async (t) => {
  const [held, release] = [gate(), gate()];
  const { session, results } = await start(t, [calls(spawn("stuck")), says("started")], () => (held.open(), release.then(says("late"))));
  t.after(() => release.open());
  const ui = new Proxy({}, { get: () => () => undefined });
  await session.bindExtensions({ uiContext: ui, mode: "rpc" }); // with a UI the run ends at once
  await session.prompt("go");
  const id = /^Subagent (\w+)/.exec(results()[0][1])[1];
  await held;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual([fleet().get(id).status, fleet().get(id).result], ["stopped", "did not stop in time"]);
  const saved = session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "rig.notice");
  assert.deepEqual(saved.map((e) => e.content), [`Subagent ${id} (do stuck) stopped. It did not stop within 10s, so its session was abandoned.`]);
});

test("stopping a nested agent frees room for a queued top-level spawn at once", { timeout: 20_000 }, async (t) => {
  const [g1Running, release] = [gate(), gate()];
  let g1AtD;
  const root = async (context) => {
    const n = context.messages.filter((m) => m.role === "toolResult").length;
    if (n === 0) return calls(spawn("C"))();
    if (n === 1) return await g1Running, calls(spawn("D"))();
    if (n === 2) return calls(["subagent_stop", { id: idOf("G1") }])();
    return says("waiting")();
  };
  const { session, results } = await start(t, Array(10).fill(root), async (context) => {
    const task = taskOf(context);
    if (task === "G1") return g1Running.open(), await release, says("late")(); // ignores its abort
    if (task === "D") return (g1AtD = fleet().get(idOf("G1")).status), release.open(), says("D done")();
    return context.messages.some((m) => m.role === "toolResult") ? says("waiting")() : calls(spawn("G1"))();
  });
  setting(t, "maxSessions", 3); // the root, C and G1
  await session.prompt("go");
  assert.match(results()[1][1], /^Subagent \w+ queued\.$/);
  assert.equal(g1AtD, "running"); // D started while G1 was still winding down
});

test("an abandoned child is disposed, spends nothing more, and holds its place in the cap until its run settles", { timeout: 40_000 }, async (t) => {
  const [gRunning, release] = [gate(), gate()];
  let fResult;
  const root = async (context) => {
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length === 0) return calls(spawn("C"))();
    if (results.length === 1) return await gRunning, calls(["subagent_stop", { id: idOf("C") }])(); // returns once C's shutdown gives up on G
    if (results.length === 2) return calls(spawn("E"), spawn("F"))();
    if (results.length === 4 && context.messages.at(-1).role === "toolResult") {
      fResult = textOf(results[3]);
      release.open(); // G's stream answers at last
    }
    return says("waiting")();
  };
  const { session, agentDir } = await start(t, Array(12).fill(root), async (context) => {
    const task = taskOf(context);
    if (task === "G") return gRunning.open(), await release, calls(["read", { path: "late.txt" }])(); // ignores its abort
    if (task === "E") return await release, says("E done")();
    if (task === "F") return says("F done")();
    return context.messages.some((m) => m.role === "toolResult") ? says("waiting")() : calls(spawn("G"))();
  });
  setting(t, "maxSessions", 3); // the root, C and G; then the root, abandoned G and E
  await session.prompt("go");
  // G, abandoned, still held its place, so F queued; it started once G's run settled.
  assert.match(fResult, /^Subagent \w+ queued\.$/);
  assert.equal(fleet().get(idOf("F")).status, "completed");
  assert.equal(fleet().get(idOf("G")).result, "did not stop in time");
  // Disposed, G's session took in nothing more: its late reply, and the tokens it cost, were never recorded.
  const files = readdirSync(join(agentDir, "sessions"), { recursive: true }).filter((f) => f.endsWith(`_${idOf("G")}.jsonl`));
  const replies = files.flatMap((f) => readFileSync(join(agentDir, "sessions", f), "utf8").trim().split("\n").map(JSON.parse)).filter((e) => e.message?.role === "assistant");
  assert.deepEqual(replies, []);
});

test("a grandchild resumed after its parent finished counts in the parent's next per-run line", { timeout: 20_000 }, async (t) => {
  let g;
  let c;
  globalThis[PRICE] = 1e-6;
  const root = (context) => {
    const results = context.messages.filter((m) => m.role === "toolResult");
    if (results.length === 0) return calls(spawn("C"))();
    if (lastText(context) === "check again") return calls(["subagent_message", { id: c, message: "check" }])();
    return says("waiting")();
  };
  const { session, agentDir, notices } = await start(t, Array(12).fill(root), (context, options) => {
    if (taskOf(context) === "G") return (g = options.sessionId), says("G\nSTATUS: DONE")();
    c ??= options.sessionId; // the fleet drops finished rows on the next prompt, so keep C's id
    if (textOf(context.messages.at(-1)).startsWith("check")) return says("C two\nSTATUS: DONE")();
    if (!context.messages.some((m) => m.role === "toolResult")) return calls(spawn("G"))();
    return says(noticed(context, "G") ? "C one\nSTATUS: DONE" : "waiting")();
  });
  await session.prompt("go");
  // C has finished; the user resumes its child G from FleetView.
  const again = new Promise((resolve) => {
    const off = fleet().subscribe(() => fleet().get(g)?.status === "completed" && fleet().get(g).result && (off(), resolve()));
  });
  const before = fleet().get(g);
  await fleet().get(g).steer("more");
  assert.notEqual(fleet().get(g), before); // a new run, a new row
  await again;
  await session.prompt("check again");

  const second = notices().filter((n) => n.startsWith(`Subagent ${c} `))[1];
  assert.match(second, /\n\nC two\nSTATUS: DONE$/);
  const run = second.split("\n")[1];
  const dir = join(agentDir, "sessions", session.sessionId);
  const entries = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(`_${c}.jsonl`))), "utf8").trim().split("\n").map(JSON.parse);
  const usage = entries.filter((e) => e.customType === "rig.subagent.usage").map((e) => e.data.tokens);
  const resumedAt = entries.findIndex((e) => e.type === "message" && e.message.role === "user" && textOf(e.message).startsWith("check"));
  const own = entries.slice(resumedAt).filter((e) => e.type === "message" && e.message.role === "assistant").reduce((n, e) => n + e.message.usage.totalTokens, 0);
  assert.equal(usage.length, 2); // G's first run, then its resumed one
  assert.equal(tokens(run), own + usage[1]);
  assert.equal(cost(run), money(tokens(run) * 1e-6));
});
