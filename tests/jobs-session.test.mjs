// Background bash and the jobs tool (#48) in scripted SDK sessions, which run without
// the UI. Commands are real processes that block on marker files the test creates, and
// every timer (auto-background, wait, kill grace) is a fake the test fires.
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension modules load in plain node
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    waitFor: (ms) => until(() => has(ms), `a ${ms} ms timer`),
    async fire(ms) {
      await until(() => has(ms), `a ${ms} ms timer`);
      for (const h of [...pending]) if (h.ms === ms) (pending.delete(h), h.fn());
    },
  };
}

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
  assert.equal(readFileSync(log, "utf8"), "started\nfinished\n");
  const got = s.notices().filter((n) => n.startsWith("Job "));
  assert.deepEqual(got, [`Job ${id} completed (exit 0) after 0s. Log: ${log}`]);
  const item = fleet().get(id);
  assert.deepEqual([item.kind, item.label, item.status, item.view.log], ["shell", `echo started; ${hold("go")}; echo finished`, "completed", log]);
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
  // The shell and a grandchild both ignore SIGTERM.
  const script = `echo $$ > pgid; trap '' TERM; sh -c 'trap "" TERM; echo child; ${hold("never")}' & ${hold("never")}`;
  const s = await start(t, [
    calls(bg(script)),
    (context) => ((id = s.jobId(lastText(context))), says("waiting")()),
    says("still waiting"),
    says("stopped, fine"),
  ]);
  const run = s.session.prompt("go");
  await until(() => id && readFileSync(fleet().get(id).view.log, "utf8").includes("child"), "the grandchild");
  const pgid = Number(readFileSync(join(s.cwd, "pgid"), "utf8"));
  const alive = liveGroup(pgid).length;
  assert.ok(alive >= 2, `shell and grandchild alive (${alive})`);
  const stopped = fleet().get(id).stop(); // FleetView's stop, as from the viewer
  await s.timers.waitFor(800);
  assert.equal(liveGroup(pgid).length, alive, "SIGTERM is ignored; nothing is killed before the grace ends");
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
