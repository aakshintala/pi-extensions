// Background bash and the jobs tool (#48) in scripted SDK sessions, which run without
// the UI. Commands are real processes that block on marker files the test creates, and
// every timer (auto-background, wait, kill grace) is a fake the test fires.
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension modules load in plain node
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { liveGroup } from "./helpers/tui.mjs";
import { fleet } from "../shared/fleet/index.ts";
import { rigSettings } from "../shared/settings/index.ts";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("../extensions/fleet/index.ts"), path("../extensions/jobs/index.ts")];
const TIMERS = Symbol.for("pi-rig.jobs.timers");

// The process's one settings instance, pinned to a directory this file owns.
const settingsDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-jobs-settings-")));
const rig = rigSettings(settingsDir);
after(() => rmSync(settingsDir, { recursive: true, force: true }));

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? `call ${c.name}`).join(""));
const lastText = (context) => textOf(context.messages.at(-1));
const says = (text) => () => fauxAssistantMessage(fauxText(text));
const calls = (...toolCalls) => () => fauxAssistantMessage(toolCalls.map(([n, a]) => fauxToolCall(n, a)), { stopReason: "toolUse" });
const bg = (command) => ["bash", { command, run_in_background: true }];
/** Blocks until `file` (relative to the session cwd) exists. */
const hold = (file) => `until [ -e ${file} ]; do sleep 0.05; done`;
/** Blocks for good as a single process, so SIGTERM ends the whole group at once. */
const FOREVER = "exec tail -f /dev/null";

async function until(ok, what) {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10); // poll interval, not a sync point
  }
}

/** Waits until the log holds `text`. */
const written = (log, text) => until(() => existsSync(log) && readFileSync(log, "utf8") === text, `${log} to hold ${JSON.stringify(text)}`);

/** Fake timers for the jobs extension. `fire(ms)` waits for a timer of that length, then runs it. */
function fakeTimers(t) {
  const pending = new Set();
  globalThis[TIMERS] = {
    setTimeout: (fn, ms) => {
      if (ms === 10) return setTimeout(fn, ms); // a killed group's zombie wait runs in real time
      const h = { fn, ms };
      pending.add(h);
      return h;
    },
    clearTimeout: (h) => pending.delete(h),
  };
  t.after(() => delete globalThis[TIMERS]);
  const has = (ms) => [...pending].some((h) => h.ms === ms);
  return {
    has,
    /** Fires every pending `ms` timer until `p` settles: for kill graces that may or may not start. */
    async pumping(ms, p) {
      const timer = setInterval(() => {
        for (const h of [...pending]) if (h.ms === ms) (pending.delete(h), h.fn());
      }, 10);
      try {
        return await settles(p, "the kill to finish");
      } finally {
        clearInterval(timer);
      }
    },
    waitFor: (ms) => until(() => has(ms), `a ${ms} ms timer`),
    async fire(ms) {
      await until(() => has(ms), `a ${ms} ms timer`);
      for (const h of [...pending]) if (h.ms === ms) (pending.delete(h), h.fn());
    },
  };
}

/** SIGKILLs a detached child's group and resolves once node has reaped it, so its group is gone. */
const killed = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : settles(new Promise((exited) => (child.once("exit", exited), process.kill(-child.pid, "SIGKILL"))), `child ${child.pid} to exit`);

/** Resolves with `p`, or fails after 10 s, so a regression fails instead of hanging. */
const settles = (p, what) => Promise.race([p, until(() => false, what)]);

async function start(t, replies) {
  const timers = fakeTimers(t);
  // Registered before the session's own clean-up, so it runs first: a failing test's job
  // (whose script wrote its group id to ./pgid) cannot hold up the session's shutdown.
  let cwd;
  t.after(() => {
    const file = cwd && join(cwd, "pgid");
    try {
      if (file && existsSync(file)) process.kill(-Number(readFileSync(file, "utf8")), "SIGKILL");
    } catch {}
  });
  let ctx;
  const capture = (pi) => pi.on("session_start", (_e, c) => (ctx = c));
  const s = await scriptedSession(t, { replies, extensions: [...EXTENSIONS, capture] });
  cwd = s.cwd;
  await s.session.bindExtensions({});
  const registry = fleet();
  const now = registry.now;
  registry.now = () => 0;
  const logDirs = new Set();
  const unsubscribe = registry.subscribe(() => {
    for (const i of registry.items()) if (i.view?.log) logDirs.add(dirname(i.view.log));
  });
  t.after(() => {
    unsubscribe();
    registry.now = now;
    for (const item of registry.items()) registry.finish(item.id, "stopped", "test over", null);
    registry.prune();
    for (const d of logDirs) rmSync(d, { recursive: true, force: true });
  });
  const results = () => s.session.messages.filter((m) => m.role === "toolResult").map((m) => [m.isError, textOf(m)]);
  const notices = () => s.session.messages.filter((m) => m.customType === "rig.notice").map(textOf);
  const jobId = (text) => /job (\w{8})\b/.exec(text)[1];
  const logOf = (text) => /Log: (\S+)/.exec(text)[1];
  return { ...s, ctx: () => ctx, timers, results, notices, jobId, logOf };
}

test("a fast command returns its output inline and leaves no job or log", async (t) => {
  const { session, results } = await start(t, [calls(["bash", { command: "echo hi; echo there >&2" }]), says("ok")]);
  await session.prompt("go");
  assert.deepEqual(results(), [[false, "hi\nthere\n"]]);
  assert.equal(fleet().items().length, 0);
});

test("a failing foreground command is an error with its exit code, as Pi's bash reports it", async (t) => {
  const { session, results } = await start(t, [calls(["bash", { command: "echo nope; exit 4" }]), says("ok")]);
  await session.prompt("go");
  assert.deepEqual(results(), [[true, "nope\n\n\nCommand exited with code 4"]]);
});

test("run_in_background returns the job ID and log path at once; one notice when it ends", async (t) => {
  let result;
  const s = await start(t, [
    calls(bg(`echo started; ${hold("go")}; echo finished`)),
    (context) => ((result = lastText(context)), says("waiting")()),
    // The session-end listing: the job is still running. Release it now.
    () => (writeFileSync(join(s.cwd, "go"), ""), says("still waiting")()),
    says("done"),
  ]);
  await s.session.prompt("go");
  const id = s.jobId(result);
  const log = s.logOf(result);
  assert.equal(result, `Started job ${id}. Log: ${log}\nA notice arrives when it ends.`);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(readFileSync(log, "utf8"), "started\nfinished\n");
  const got = s.notices().filter((n) => n.startsWith("Job "));
  assert.deepEqual(got, [`Job ${id} completed (exit 0) after 0s. Log: ${log}`]);
  const item = fleet().get(id);
  assert.deepEqual([item.kind, item.label, item.status, item.view.log], ["shell", `echo started; ${hold("go")}; echo finished`, "completed", log]);
  assert.equal(s.timers.has(1000), false, "its log and group check ends with it");
});

test("a command still running after autoBackgroundSeconds becomes a job; the setting comes from rig.json", async (t) => {
  writeFileSync(rig.path, JSON.stringify({ jobs: { autoBackgroundSeconds: 5 } }));
  t.after(() => rmSync(rig.path, { force: true }));
  let result;
  const s = await start(t, [
    calls(["bash", { command: `echo early; ${hold("go")}; echo late` }]),
    (context) => ((result = lastText(context)), says("waiting")()),
    () => (writeFileSync(join(s.cwd, "go"), ""), says("still waiting")()),
    says("done"),
  ]);
  const bash = s.session.extensionRunner.getToolDefinition("bash");
  assert.match(bash.description, /still running after 5s moves to the background/);
  const run = s.session.prompt("go");
  await s.timers.fire(5000);
  await run;
  const id = s.jobId(result);
  const log = s.logOf(result);
  assert.equal(result, `Still running after 5s, so it moved to the background as job ${id}. Log: ${log}\nA notice arrives when it ends.`);
  assert.equal(readFileSync(log, "utf8"), "early\nlate\n");
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} completed (exit 0) after 0s. Log: ${log}`]);
});

test("the default auto-background wait is 30 s", async (t) => {
  const s = await start(t, [calls(["bash", { command: hold("go") }]), says("waiting"), () => (writeFileSync(join(s.cwd, "go"), ""), says("ok")()), says("done")]);
  const run = s.session.prompt("go");
  await s.timers.fire(30_000);
  await run;
  assert.match(s.results()[0][1], /^Still running after 30s/);
});

test("Ctrl+B backgrounds a foreground command: its call returns the job ID and log path, and only it is listed", async (t) => {
  let result;
  const s = await start(t, [
    calls(["bash", { command: `echo early; ${hold("go")}; echo late` }]),
    (context) => ((result = lastText(context)), says("waiting")()),
    () => (writeFileSync(join(s.cwd, "go"), ""), says("still waiting")()),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  await until(() => fleet().foregrounds() === 1, "the foreground command");
  fleet().backgroundAll("another session"); // a steer in another session leaves it alone
  assert.equal(fleet().foregrounds(), 1);
  fleet().backgroundAll(); // what Ctrl+B calls
  assert.equal(fleet().foregrounds(), 0);
  await run;
  const id = s.jobId(result);
  const log = s.logOf(result);
  assert.equal(result, `Moved to the background as job ${id}. Log: ${log}\nA notice arrives when it ends.`);
  assert.equal(readFileSync(log, "utf8"), "early\nlate\n");
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} completed (exit 0) after 0s. Log: ${log}`]);
  assert.equal(s.timers.has(30_000), false, "the auto-background timer is cleared");
});

test("a command that ends in the foreground is no longer listed for Ctrl+B", async (t) => {
  const s = await start(t, [calls(["bash", { command: "echo hi" }]), says("ok")]);
  await s.session.prompt("go");
  assert.equal(fleet().foregrounds(), 0);
  assert.deepEqual(s.results(), [[false, "hi\n"]]);
});

test("a failure notice carries the last 20 lines, cut to 2,000 characters", async (t) => {
  let result;
  const s = await start(t, [
    calls(bg(`${hold("go")}; for i in $(seq 1 30); do printf 'line %03d %0140d\\n' $i 0; done; exit 3`)),
    (context) => ((result = lastText(context)), says("waiting")()),
    () => (writeFileSync(join(s.cwd, "go"), ""), says("still waiting")()),
    says("done"),
  ]);
  await s.session.prompt("go");
  const id = s.jobId(result);
  const log = s.logOf(result);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 30);
  const tail = lines.slice(-20).join("\n").slice(-2000);
  assert.equal(tail.length, 2000);
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} failed (exit 3) after 0s. Log: ${log}\nLast lines:\n${tail}`]);
  assert.equal(fleet().get(id).result, `exit 3\n${tail}`);
});

test("a wait that returns the final state suppresses the notice", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(`${hold("go")}; echo out`)),
    (context) => ((id = s.jobId(lastText(context))), calls(["jobs", { action: "wait", id }])()),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  await s.timers.waitFor(30_000); // the wait's default timeout
  writeFileSync(join(s.cwd, "go"), "");
  await run;
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.results().at(-1), [false, `Job ${id} completed (exit 0) after 0s. Log: ${log}\nLast lines:\nout`]);
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), []);
  assert.equal(fleet().get(id).status, "completed");
});

test("wait times out with the job running, its timeout clamped to 10-3,600 s; list and stop; other sessions see none of it", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(`echo working; ${FOREVER}`)),
    async (context) => {
      id = s.jobId(lastText(context));
      await written(s.logOf(lastText(context)), "working\n");
      return calls(["jobs", { action: "wait", id, timeout: 1 }])();
    },
    () => calls(["jobs", { action: "wait", id, timeout: 99999 }])(),
    calls(["jobs", { action: "list" }]),
    () => calls(["jobs", { action: "stop", id }])(),
    () => calls(["jobs", { action: "stop", id }], ["jobs", { action: "wait" }], ["jobs", { action: "stop", id: "nope1234" }])(),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  await s.timers.fire(10_000);
  await s.timers.fire(3_600_000);
  await run;
  const log = fleet().get(id).view.log;
  const r = s.results();
  assert.deepEqual(r[1], [false, `Job ${id} running after 0s. Log: ${log}\nLast lines:\nworking`]);
  assert.deepEqual(r[2], r[1]);
  assert.deepEqual(r[3], [false, `Job ${id} running after 0s. Log: ${log}\n  $ echo working; ${FOREVER}`]);
  assert.deepEqual(r[4], [false, `Job ${id} stopped (exit 143) after 0s. Log: ${log}\nLast lines:\nworking`]);
  assert.deepEqual(r[5], r[4]); // already stopped
  assert.deepEqual(r[6], [true, "wait needs an id."]);
  assert.deepEqual(r[7], [true, "No job nope1234 of yours. Use an id from jobs list."]);
  // The stop returned the final state: no notice.
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), []);

  // Another session, such as a subagent, cannot see, wait on or stop this job.
  const other = { ...s.ctx(), sessionManager: { getSessionId: () => "other" } };
  const jobs = s.session.extensionRunner.getToolDefinition("jobs");
  const list = await jobs.execute("c1", { action: "list" }, undefined, undefined, other);
  assert.equal(list.content[0].text, "No jobs.");
  await assert.rejects(jobs.execute("c2", { action: "stop", id }, undefined, undefined, other), { message: `No job ${id} of yours. Use an id from jobs list.` });
});

test("cancelling a wait leaves the job running", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(hold("go"))),
    (context) => ((id = s.jobId(lastText(context))), calls(["jobs", { action: "wait", id }])()),
    says("never reached"),
  ]);
  const run = s.session.prompt("go");
  await s.timers.waitFor(30_000);
  await s.session.abort();
  await run;
  assert.equal(s.results().at(-1)[1], `Wait cancelled. Job ${id} is still running.`);
  assert.equal(fleet().get(id).status, "running");
  assert.equal(s.timers.has(30_000), false, "the wait's timer is cleared");
  writeFileSync(join(s.cwd, "go"), "");
  await until(() => fleet().get(id).status === "completed", "the job to finish");
});

test("stop sends SIGTERM to the process group and SIGKILL 800 ms later; the row's stop sends one notice", async (t) => {
  let id;
  // The shell and everything it starts ignore SIGTERM (an ignored signal stays ignored
  // across fork and exec): the shell, a tail and a grandchild tail, none of which come and go.
  const script = `echo $$ > pgid; trap '' TERM; sh -c 'echo child; exec tail -f /dev/null' & tail -f /dev/null`;
  const s = await start(t, [
    calls(bg(script)),
    (context) => ((id = s.jobId(lastText(context))), says("waiting")()),
    says("still waiting"),
    says("stopped, fine"),
  ]);
  const run = s.session.prompt("go");
  await until(() => id && readFileSync(fleet().get(id).view.log, "utf8").includes("child"), "the grandchild");
  const pgid = Number(readFileSync(join(s.cwd, "pgid"), "utf8"));
  await until(() => liveGroup(pgid).length === 3, "the shell and both tails");
  const stopped = fleet().get(id).stop(); // FleetView's stop, as from the viewer
  await s.timers.waitFor(800);
  assert.equal(liveGroup(pgid).length, 3, "SIGTERM is ignored; nothing is killed before the grace ends");
  await s.timers.fire(800);
  await settles(stopped, "the stop to finish");
  await run;
  await until(() => liveGroup(pgid).length === 0, "SIGKILL to reach the group");
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} stopped (exit 137) after 0s. Log: ${log}`]);
});

test("bash timeout kills the command; after backgrounding, the job fails as timed out", async (t) => {
  let result;
  const s = await start(t, [
    calls(["bash", { command: `echo a; touch ready; ${FOREVER}`, timeout: 2 }], ["bash", { command: FOREVER, timeout: 0 }]),
    calls(["bash", { command: `echo b; ${FOREVER}`, timeout: 60, run_in_background: true }]),
    (context) => ((result = lastText(context)), says("waiting")()),
    says("still waiting"),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  await until(() => existsSync(join(s.cwd, "ready")), "the first command's output");
  await s.timers.fire(2000);
  await until(() => s.results().length >= 2, "the first two results");
  await until(() => result, "the job's start");
  await written(s.logOf(result), "b\n");
  await s.timers.fire(60_000);
  await run;
  const r = s.results();
  assert.deepEqual(r[0], [true, "a\n\n\nCommand timed out after 2 seconds"]);
  assert.deepEqual(r[1], [true, "timeout must be a positive number of seconds"]);
  const id = s.jobId(result);
  const log = s.logOf(result);
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} failed (exit 143), timed out after 60s after 0s. Log: ${log}\nLast lines:\nb`]);
});

for (const reason of ["quit", "new"]) {
  test(`session shutdown (${reason}) kills every job without a notice`, async (t) => {
    let id;
    const s = await start(t, [
      calls(bg(`echo $$ > pgid; ${FOREVER}`)),
      (context) => ((id = s.jobId(lastText(context))), says("waiting")()),
      says("still waiting"),
    ]);
    const run = s.session.prompt("go");
    await until(() => id && existsSync(join(s.cwd, "pgid")) && readFileSync(join(s.cwd, "pgid"), "utf8").endsWith("\n"), "the job");
    const pgid = Number(readFileSync(join(s.cwd, "pgid"), "utf8"));
      await s.session.extensionRunner.emit({ type: "session_shutdown", reason });
    await run;
    assert.deepEqual(liveGroup(pgid), []);
    assert.equal(fleet().get(id).status, "stopped");
    assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), []);
  });
}

test("aborting the turn kills a foreground command", async (t) => {
  const s = await start(t, [calls(["bash", { command: `echo $$ > pgid; ${FOREVER}` }]), says("never reached")]);
  const run = s.session.prompt("go");
  const file = join(s.cwd, "pgid");
  await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), "the command");
  const pgid = Number(readFileSync(file, "utf8"));
  await settles(Promise.all([s.session.abort(), run]), "the aborted run to end");
  assert.deepEqual(s.results(), [[true, "Command aborted"]]);
  assert.deepEqual(liveGroup(pgid), []);
  assert.equal(fleet().items().length, 0);
});

/** The group id a job's script wrote to `file` in the session cwd. */
const pgidIn = async (s, file = "pgid") => {
  const path = join(s.cwd, file);
  await until(() => existsSync(path) && readFileSync(path, "utf8").endsWith("\n"), path);
  return Number(readFileSync(path, "utf8"));
};

test("a job whose shell exits with a child still running says so, and stop ends the child", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg("echo $$ > pgid; sleep 60 & echo spawned")),
    async (context) => {
      id = s.jobId(lastText(context));
      await until(() => fleet().get(id)?.status === "completed", "the shell to exit");
      return calls(["jobs", { action: "stop", id }])();
    },
    says("done"),
  ]);
  await s.timers.pumping(800, s.session.prompt("go"));
  const pgid = await pgidIn(s);
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [
    `Job ${id} completed (exit 0) after 0s. Log: ${log}\nIts shell exited, but processes it started are still running; stop ends them.`,
  ]);
  assert.deepEqual(s.results().at(-1), [false, `Job ${id} completed (exit 0) after 0s. Log: ${log}\nLast lines:\nspawned`]);
  await until(() => liveGroup(pgid).length === 0, "the child to be stopped");
});

test("shutdown ends what finished commands left running, background and foreground", async (t) => {
  const s = await start(t, [
    calls(bg("echo $$ > pgid; sleep 60 &"), ["bash", { command: "echo $$ > fgpgid; sleep 60 &" }]),
    says("done"),
  ]);
  await s.session.prompt("go");
  const groups = [await pgidIn(s), await pgidIn(s, "fgpgid")];
  for (const g of groups) assert.notDeepEqual(liveGroup(g), [], `group ${g} has its sleep`);
  await s.timers.pumping(800, s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
  for (const g of groups) await until(() => liveGroup(g).length === 0, `group ${g} to be gone`);
});

test("one session's shutdown stops only its own jobs; the other keeps getting notices", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(hold("go"))),
    (context) => ((id = s.jobId(lastText(context))), says("waiting")()),
    async () => {
      // A second session in this process, with its own instance of the extension.
      const tools = new Map();
      const handlers = new Map();
      const { default: jobs } = await import("../extensions/jobs/index.ts");
      jobs({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
      const other = { cwd: s.cwd, sessionManager: { getSessionId: () => "other", getSessionFile: () => undefined } };
      await tools.get("bash").execute("b1", { command: `echo $$ > otherpgid; ${FOREVER}`, run_in_background: true }, undefined, undefined, other);
      const otherPgid = await pgidIn(s, "otherpgid");
      await handlers.get("session_shutdown")();
      await until(() => liveGroup(otherPgid).length === 0, "the other session's job to stop");
      assert.equal(fleet().get(id).status, "running");
      writeFileSync(join(s.cwd, "go"), "");
      return says("still waiting")();
    },
    says("done"),
  ]);
  await s.session.prompt("go");
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} completed (exit 0) after 0s. Log: ${fleet().get(id).view.log}`]);
});

test("tool output is drawn without terminal sequences or control characters", async (t) => {
  const s = await start(t, []);
  const theme = { fg: (_k, text) => text, bold: (text) => text };
  const result = { content: [{ type: "text", text: "\x1b[2Jfirst\x1b[31m red\x1b[0m\x07\r\n\x1b]0;title\x07tab\there\x1b[1A" }] };
  for (const name of ["bash", "jobs"]) {
    const tool = s.session.extensionRunner.getToolDefinition(name);
    const context = { toolCallId: `x-${name}`, args: {}, cwd: s.cwd, isError: false, isPartial: false, expanded: true };
    const lines = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(80).map((l) => l.trimEnd());
    assert.deepEqual(lines, ["   ⎿  first red", "      tab\there"], name);
  }
});

test("a Pi that exits without shutting down still kills its job groups", async (t) => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-jobs-crash-")));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path("./fixtures/jobs/crash.mjs")], { cwd: box, env: { ...process.env, PI_CODING_AGENT_DIR: box, HOME: box }, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stderr);
  const [pgid, log] = r.stdout.trim().split("\n");
  t.after(() => rmSync(dirname(log), { recursive: true, force: true }));
  await until(() => liveGroup(Number(pgid)).length === 0, `group ${pgid} to be killed at exit`);
});

// Guards and crash clean-up (#49).

test("a bare sleep is refused; sleep in a polling loop or in the background runs", async (t) => {
  const s = await start(t, [
    calls(["bash", { command: "echo a; sleep 1" }], ["bash", { command: "until true; do sleep 1; done; echo polled" }], ["bash", { command: "sleep 0 & echo bg" }]),
    says("done"),
  ]);
  await s.session.prompt("go");
  const r = s.results();
  assert.deepEqual(r[0], [
    true,
    "Blocked: a bare sleep only waits. To wait for a condition, poll in a loop (until <check>; do sleep 1; done). " +
      "To wait for a job, use jobs wait. For long work, set run_in_background; to react to output, use monitor.",
  ]);
  assert.deepEqual(r.slice(1), [
    [false, "polled\n"],
    [false, "bg\n"],
  ]);
});

test("the sleep check reads shell structure, not the word", async () => {
  const { blockingSleep } = await import("../extensions/jobs/guards.ts");
  const cases = {
    "sleep 5": true,
    "sleep 5 && echo hi": true,
    "echo a\nsleep 5": true,
    "FOO=1 sleep 5 2>&1": true,
    "sleep 5 &>/dev/null": true,
    "if x; then sleep 5; fi": true,
    "(sleep 5)": true,
    "x | sleep 5": true,
    "while x; do :; done; sleep 5": true,
    "for i in 1 2; do sleep 1; done": true, // only while and until poll
    "cat <<'EOF' | x\nsleep 5\nEOF\nsleep 1": true,
    "{ sleep 1; }": true,
    "f() { echo; }; sleep 1": true,
    "command sleep 5": true,
    "exec sleep 5": true,
    "env -i FOO=1 sleep 5": true,
    "nice -n 5 sleep 5": true,
    "nohup sleep 5": true,
    "timeout -s KILL 10 sleep 5": true,
    "/bin/sleep 5": true,
    "\\sleep 5": true,
    "'sleep' 5": true,
    "`sleep 5`": true,
    "echo `sleep 5`": true,
    "echo $(x; sleep 5)": true,
    'x="$(sleep 5)"': true,
    "until [ -e f ]; do sleep 0.05; done": false,
    "until curl -s localhost:3000 >/dev/null; do\n  sleep 1\ndone": false,
    "while x; do for i in 1 2; do sleep 1; done; done": false,
    "sleep 60 &": false,
    "echo sleep 5": false,
    "echo 'sleep 5'": false,
    'echo "a; sleep 5"': false,
    "echo a \\; sleep 5": false,
    "while x; do y=$(sleep 1); done": false,
    "f() { sleep 1; }": false,
    "function f { sleep 1; }": false,
    "function f() {\n  sleep 1\n}\necho": false,
    "command -v sleep": false,
    "timeout 5 sleepy": false,
    "cat <<EOF\nsleep 5\nEOF\necho": false,
    "# sleep 5\necho": false,
    "sleepy 5": false,
  };
  for (const [command, blocks] of Object.entries(cases)) assert.equal(blockingSleep(command), blocks, command);
});

test("only an unfinished prompt-shaped line counts as a prompt", async () => {
  const { PROMPT } = await import("../extensions/jobs/guards.ts");
  const lines = {
    "Continue? [y/N] ": true,
    "Password: ": true,
    "[sudo] password for me:": true,
    "Enter passphrase for key '/k': ": true,
    "? Pick a template ": true,
    "Are you sure? ": true,
    "> ": true,
    "Why?": false,
    "password reset done": false,
    "checked password policy: ok": false,
    "Compiling foo": false,
  };
  for (const [line, prompt] of Object.entries(lines)) assert.equal(PROMPT.test(line), prompt, line);
});

test("a job whose log passes 5 GB is stopped, and its notice says why", async (t) => {
  let id;
  // Extends its log to just past 5 GB without writing it (a sparse file), then blocks.
  const grow = `'${process.execPath}' -e 'require("fs").ftruncateSync(1, 5 * 1024 ** 3 + 1)'; ${FOREVER}`;
  const s = await start(t, [calls(bg(grow)), (context) => ((id = s.jobId(lastText(context))), says("waiting")()), says("still waiting"), says("done")]);
  const run = s.session.prompt("go");
  await until(() => id && statSync(fleet().get(id).view.log).size > 5 * 1024 ** 3, "the log to grow");
  await s.timers.fire(1000);
  await s.timers.pumping(800, run);
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} stopped (exit 143) after 0s because its output passed 5 GB. Log: ${log}`]);
});

test("a job whose output stops on a prompt warns the agent once", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(`printf 'working\\nContinue? [y/N] '; ${FOREVER}`), bg(`echo quiet; ${FOREVER}`)),
    (context) => ((id = s.jobId(textOf(context.messages.at(-2)))), says("waiting")()),
    says("warned"),
    says("still waiting"),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  await until(() => id && existsSync(fleet().get(id).view.log) && readFileSync(fleet().get(id).view.log, "utf8").endsWith("[y/N] "), "the prompt");
  const warning = `Job ${id} may be waiting for input: its output stopped at "Continue? [y/N]". It gets no input; stop it and rerun it non-interactively.`;
  const warnings = () => s.notices().filter((n) => n.includes("waiting for input"));
  for (let i = 0; i < 10; i++) await s.timers.fire(1000); // one tick sees the output, nine see it unchanged
  assert.deepEqual(warnings(), []);
  await s.timers.fire(1000);
  await until(() => warnings().length === 1, "the warning");
  for (let i = 0; i < 12; i++) await s.timers.fire(1000);
  for (const item of fleet().items()) if (item.kind === "shell") await s.timers.pumping(800, item.stop());
  await run;
  assert.deepEqual(warnings(), [warning]);
});

test("at most 16 jobs and monitors run at once; more starts are refused, foreground commands still run", async (t) => {
  const s = await start(t, [
    calls(bg(hold("go")), bg(hold("go")), ["bash", { command: "echo fine" }]),
    () => (writeFileSync(join(s.cwd, "go"), ""), says("waiting")()),
    says("done"),
  ]);
  // 15 groups tracked by others in this process, such as monitors or another session's jobs.
  const { track } = await import("../shared/process-groups/index.ts");
  for (let i = 0; i < 15; i++) {
    const child = spawn("tail", ["-f", "/dev/null"], { detached: true, stdio: "ignore" });
    // Waits for the exit: until it is reaped, the group still counts toward the cap.
    t.after(() => killed(child));
    track({ child, pgid: child.pid, record: join(s.cwd, `other${i}.pid`), counted: true });
  }
  await s.session.prompt("go");
  const r = s.results();
  assert.match(r[0][1], /^Started job/);
  assert.deepEqual(r.slice(1), [
    [true, "Not started: 16 jobs and monitors are running, the most allowed. Wait for one or stop one with jobs, then retry."],
    [false, "fine\n"],
  ]);
});

test("maxJobs in rig.json sets the limit", async (t) => {
  writeFileSync(rig.path, JSON.stringify({ jobs: { maxJobs: 1 } }));
  t.after(() => rmSync(rig.path, { force: true }));
  const s = await start(t, [calls(bg(hold("go")), bg(hold("go"))), () => (writeFileSync(join(s.cwd, "go"), ""), says("waiting")()), says("done")]);
  await s.session.prompt("go");
  assert.match(s.results()[1][1], /^Not started: 1 jobs and monitors are running/);
});

/** A job's crash record: its group, and the start times of the group leader and of Pi. */
const recordOf = (log) => join(dirname(log), `${/(\w+)\.log$/.exec(log)[1]}.pid`);
const ps = (pid) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.trim();

test("a shell's leftover processes whose output passes 5 GB are stopped, with a notice", async (t) => {
  let id;
  const grow = `'${process.execPath}' -e 'require("fs").ftruncateSync(1, 5 * 1024 ** 3 + 1)'; exec tail -f /dev/null`;
  const s = await start(t, [calls(bg(`echo $$ > pgid; sh -c "${grow.replace(/"/g, '\\"')}" &`)), (context) => ((id = s.jobId(lastText(context))), says("waiting")()), says("noted"), says("done")]);
  const run = s.session.prompt("go");
  const pgid = await pgidIn(s);
  await until(() => id && fleet().get(id)?.status === "completed" && statSync(fleet().get(id).view.log).size > 5 * 1024 ** 3, "the shell to exit and the log to grow");
  await s.timers.fire(1000);
  await s.timers.pumping(800, run);
  await until(() => liveGroup(pgid).length === 0, "the leftover writer to be stopped");
  await until(() => s.notices().filter((n) => n.startsWith("Job ")).length === 2, "the notice");
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [
    `Job ${id} completed (exit 0) after 0s. Log: ${log}\nIts shell exited, but processes it started are still running; stop ends them.`,
    `Job ${id}: the processes its shell left running were stopped because its output passed 5 GB. Log: ${log}`,
  ]);
});

test("each job's group and start time are recorded until its group is empty, lingering children included", async (t) => {
  let id;
  const s = await start(t, [
    calls(bg(`echo $$ > pgid; sleep 60 & echo $! > child; ${hold("go")}`)),
    (context) => ((id = s.jobId(lastText(context))), says("waiting")()),
    says("still waiting"),
    says("done"),
  ]);
  const run = s.session.prompt("go");
  const pgid = await pgidIn(s);
  const child = await pgidIn(s, "child");
  const record = recordOf(fleet().get(id).view.log);
  assert.equal(existsSync(record), true, "written when the job starts");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { pi: process.pid, piStart: ps(process.pid), pgid, start: ps(pgid) });
  writeFileSync(join(s.cwd, "go"), "");
  await run;
  assert.equal(existsSync(record), true, "the shell exited, its sleep still runs");
  process.kill(child, "SIGKILL");
  await until(() => liveGroup(pgid).length === 0, "the sleep to die");
  await s.timers.fire(1000);
  assert.equal(existsSync(record), false, "the empty group is forgotten");
});

test("a hanging ps delays a spawn by at most its 1 s timeout, and no record is written", async (t) => {
  const { startTimeSync, track } = await import("../shared/process-groups/index.ts");
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-jobs-ps-")));
  const child = spawn("tail", ["-f", "/dev/null"], { detached: true, stdio: "ignore" });
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
    return killed(child);
  });
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`;
  const began = Date.now();
  assert.equal(startTimeSync(child.pid), undefined);
  track({ child, pgid: child.pid, record: join(bin, "x.pid") });
  const took = Date.now() - began;
  assert.ok(took < 4500, `up to three ps runs (this one, Pi's and the leader's) took ${took} ms`); // 10-15 s without the timeout
  assert.equal(existsSync(join(bin, "x.pid")), false, "an unknown start time writes no record");
});

test("a killed Pi's jobs and monitors are reaped on the next start; nothing else is", async (t) => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-jobs-reap-")));
  const strays = [];
  t.after(() => {
    for (const p of strays)
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {}
    rmSync(box, { recursive: true, force: true });
  });
  // A ps that fails for this test's own pid, as a ps run can.
  const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(join(box, "bin"));
  writeFileSync(join(box, "bin", "ps"), `#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = "${process.pid}" ] && exit 1\nexec ${realPs} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: box, HOME: box, TMPDIR: box, PATH: `${join(box, "bin")}:${process.env.PATH}` };
  const crash = spawnSync(process.execPath, [path("./fixtures/jobs/crash.mjs"), "kill"], { cwd: box, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(crash.signal, "SIGKILL", crash.stderr);
  const [pgid, log, deadPi] = crash.stdout.trim().split("\n");
  strays.push({ pid: Number(pgid) });
  assert.notDeepEqual(liveGroup(Number(pgid)), [], "no exit handler ran");

  // Unrelated groups with planted records.
  const forge = (dir, record, { dirMode = 0o700, fileMode = 0o600 } = {}) => {
    const p = spawn("tail", ["-f", "/dev/null"], { detached: true, stdio: "ignore" });
    strays.push(p);
    mkdirSync(join(box, dir), { mode: dirMode });
    chmodSync(join(box, dir), dirMode);
    const file = join(box, dir, "x.pid");
    writeFileSync(file, typeof record === "string" ? record : JSON.stringify({ pgid: p.pid, ...record(p) }), { mode: fileMode });
    chmodSync(file, fileMode);
    return { p, file };
  };
  const dead = (p) => ({ pi: Number(deadPi), piStart: "gone", start: ps(p.pid) });
  const monitor = forge("pi-monitor-x", dead);
  const reused = forge("pi-jobs-reused", () => ({ pi: Number(deadPi), piStart: "gone", start: "Mon Jan  1 00:00:00 2001" }));
  const live = forge("pi-jobs-live", (p) => ({ pi: process.pid, piStart: ps(process.pid), start: ps(p.pid) })); // its ps fails
  const openDir = forge("pi-jobs-open", dead, { dirMode: 0o755 });
  const openFile = forge("pi-jobs-openfile", dead, { fileMode: 0o644 });
  const everything = forge("pi-jobs-one", (p) => ({ pi: Number(deadPi), piStart: "gone", pgid: 1, start: ps(1) }));
  const malformed = forge("pi-jobs-bad", "{not json");
  await until(() => [monitor, reused, live, openDir, openFile].every((f) => ps(f.p.pid)), "the strays");

  const reap = spawnSync(process.execPath, [path("./fixtures/jobs/crash.mjs"), "reap"], { cwd: box, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(reap.status, 0, reap.stderr);
  assert.equal(reap.stdout, "", "no signal to pid 1 or every process");
  await until(() => liveGroup(Number(pgid)).length === 0, "the killed Pi's job to be reaped");
  assert.equal(existsSync(recordOf(log)), false);
  await until(() => liveGroup(monitor.p.pid).length === 0, "the killed Pi's monitor to be reaped");
  assert.equal(existsSync(monitor.file), false);
  for (const [f, what] of [
    [reused, "a reused pid"],
    [live, "a live Pi's job whose ps failed"],
    [openDir, "a record in a directory others can write"],
    [openFile, "a record others can write"],
  ])
    assert.notDeepEqual(liveGroup(f.p.pid), [], `${what} is left alone`);
  assert.deepEqual(
    [reused, live, openDir, openFile, everything, malformed].map((f) => existsSync(f.file)),
    [false, true, true, true, false, false],
    "a dead Pi's records and malformed ones are dropped; the rest are kept",
  );
});

test("jobs stop ends the caller's monitors through their rows", async (t) => {
  const s = await start(t, [
    calls(["jobs", { action: "stop", id: "mine1234" }], ["jobs", { action: "stop", id: "theirs12" }], ["jobs", { action: "wait", id: "mine1234" }]),
    says("done"),
  ]);
  const stops = [];
  const monitor = (id, owner) =>
    fleet().register({ id, owner, kind: "monitor", label: id, activity: () => "", view: { log: join(s.cwd, "rows", "x.log") }, stop: () => (stops.push(id), fleet().finish(id, "stopped", "stopped", null)) });
  monitor("mine1234", s.session.sessionManager.getSessionId());
  monitor("theirs12", "other");
  await settles(s.session.prompt("go"), "the run to end"); // a monitor left running would hold it
  assert.deepEqual(s.results(), [
    [false, "Monitor mine1234 stopped."],
    [true, "No job theirs12 of yours. Use an id from jobs list."],
    [true, "No job mine1234 of yours. Use an id from jobs list."],
  ]);
  assert.deepEqual(stops, ["mine1234"]);
});

test("a stop whose SIGKILL is still pending does not report leftover processes (#122)", async (t) => {
  let id;
  // The shell dies on SIGTERM; its child ignores it and lives until the SIGKILL.
  const script = `echo $$ > pgid; (trap '' TERM; echo child; exec tail -f /dev/null) & wait`;
  const s = await start(t, [calls(bg(script)), (context) => ((id = s.jobId(lastText(context))), says("waiting")()), says("still waiting"), says("done")]);
  const run = s.session.prompt("go");
  await until(() => id && readFileSync(fleet().get(id).view.log, "utf8").includes("child"), "the child");
  const pgid = await pgidIn(s);
  await until(() => liveGroup(pgid).length === 2, "the shell and its child");
  const stopped = fleet().get(id).stop();
  await until(() => fleet().get(id).status === "stopped", "the shell to exit on SIGTERM");
  assert.equal(liveGroup(pgid).length, 1, "the child waits for the SIGKILL");
  await s.timers.fire(800);
  await settles(stopped, "the stop to finish");
  await run;
  const log = fleet().get(id).view.log;
  assert.deepEqual(s.notices().filter((n) => n.startsWith("Job ")), [`Job ${id} stopped (exit 143) after 0s. Log: ${log}`]);
});
