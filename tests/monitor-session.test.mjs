// The monitor tool (#50) in scripted SDK sessions, which run without the UI. The watch
// command is tests/fixtures/monitor/batches.sh: it prints each batch when the test writes
// it, so the test controls what arrives together. Notices are read from the fleet
// registry's delivery for the session, and every timer is a fake the test fires.
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension modules load in plain node
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { liveGroup } from "./helpers/tui.mjs";
import { fleet } from "../shared/fleet/index.ts";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT = path("./fixtures/monitor/batches.sh");
const TIMERS = Symbol.for("pi-rig.monitor.timers");

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? `call ${c.name}`).join(""));
const says = (text) => () => fauxAssistantMessage(fauxText(text));
const calls = (args) => () => fauxAssistantMessage([fauxToolCall("monitor", args)], { stopReason: "toolUse" });

async function until(ok, what) {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10); // poll interval, not a sync point
  }
}

/** Resolves with `p`, or fails after 10 s, so a regression fails instead of hanging. */
const settles = (p, what) => Promise.race([p, until(() => false, what)]);

/** Fake timers for the monitor extension. */
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
    /** Runs one pending timer of `ms`. */
    fire(ms) {
      const h = [...pending].find((h) => h.ms === ms);
      assert.ok(h, `no ${ms} ms timer`);
      pending.delete(h);
      h.fn();
    },
  };
}

/** Starts a session whose model calls monitor with `args` (command defaults to the fixture). */
async function start(t, args = {}, { ui = false } = {}) {
  const timers = fakeTimers(t);
  let cwd;
  t.after(() => {
    try {
      process.kill(-Number(readFileSync(join(cwd, "pgid"), "utf8")), "SIGKILL");
    } catch {}
  });
  let ctx;
  const capture = (pi) => pi.on("session_start", (_e, c) => (ctx = c));
  const s = await scriptedSession(t, { replies: [calls({ command: `sh ${SCRIPT}`, description: "watch builds", ...args }), says("ok")], extensions: [path("../extensions/monitor/index.ts"), capture] });
  cwd = s.cwd;
  await s.session.bindExtensions({});
  const notices = [];
  const detach = fleet().attach(s.session.sessionManager.getSessionId(), (n) => notices.push(n.text));
  const logDirs = new Set();
  const off = fleet().subscribe(() => {
    for (const i of fleet().items()) if (i.view?.log) logDirs.add(dirname(i.view.log));
  });
  t.after(() => {
    off();
    detach();
    for (const item of fleet().items()) fleet().finish(item.id, "stopped", "test over", null);
    fleet().prune();
    for (const d of logDirs) rmSync(d, { recursive: true, force: true });
  });
  let result;
  if (ui) {
    // An interactive session: call the tool as Pi would with the UI.
    const tool = s.session.extensionRunner.getToolDefinition("monitor");
    result = textOf(await tool.execute("c1", { command: `sh ${SCRIPT}`, description: "watch builds", ...args }, undefined, undefined, { ...ctx, hasUI: true }));
  } else {
    await s.session.prompt("go");
    result = textOf(s.session.messages.find((m) => m.role === "toolResult"));
  }
  const id = /monitor (\w{8})/.exec(result)[1];
  const item = fleet().get(id);
  const log = item.view.log;
  let n = 0;
  let written = "";
  /** Prints `text` as one batch and waits until the monitor has read it. */
  const send = async (text) => {
    n++;
    writeFileSync(join(cwd, "tmp"), text);
    renameSync(join(cwd, "tmp"), join(cwd, `m${n}`));
    written += text;
    await until(() => readFileSync(log, "utf8") === written, `batch ${n} in the log`);
  };
  /** Makes the command exit with `code`. */
  const exit = (code) => {
    n++;
    writeFileSync(join(cwd, "tmp"), String(code));
    renameSync(join(cwd, "tmp"), join(cwd, `e${n}`));
  };
  const pgid = async () => {
    await until(() => existsSync(join(cwd, "pgid")) && readFileSync(join(cwd, "pgid"), "utf8").endsWith("\n"), "the pgid");
    return Number(readFileSync(join(cwd, "pgid"), "utf8"));
  };
  const ended = () => until(() => fleet().get(id).status !== "running", "the monitor to end");
  return { ...s, timers, notices, result, id, item, log, send, exit, pgid, ended };
}

test("each batch of lines is one notice with the description; stderr has its own log; the exit ends it", async (t) => {
  const s = await start(t);
  const errors = s.log.replace(/\.log$/, ".err.log");
  assert.equal(s.result, `Started monitor ${s.id}; its output lines arrive as notices until it ends or after 300s. Log: ${s.log}. Errors: ${errors}`);
  assert.deepEqual([s.item.kind, s.item.label, s.item.status], ["monitor", "watch builds", "running"]);
  assert.equal(statSync(s.log).mode & 0o777, 0o600);
  await s.send("build 1 ok\nbuild 2 \x1b[31mfailed\x1b[0m\n");
  await s.send("build 3 ok\npartial");
  await s.send(" line");
  s.exit(3);
  await s.ended();
  await until(() => readFileSync(errors, "utf8") === "to stderr\n", "the error log");
  const head = `Monitor ${s.id} (watch builds)`;
  assert.deepEqual(s.notices, [
    `${head}:\nbuild 1 ok\nbuild 2 failed`,
    `${head}:\nbuild 3 ok`,
    `${head}:\npartial line`, // a last line with no newline, delivered at the end
    `${head} ended: its command exited with code 3. Log: ${s.log}. Errors: ${errors}`,
  ]);
  assert.deepEqual([fleet().get(s.id).status, fleet().get(s.id).result], ["failed", "exit 3"]);
});

test("lines are cut at 500 characters and a notice at 3,000", async (t) => {
  const s = await start(t);
  const long = "x".repeat(700);
  const lines = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(450, "y"));
  await s.send(`${long}\n${lines.join("\n")}\n`);
  const [notice] = s.notices;
  assert.equal(notice.length, 3000);
  assert.equal(notice, [`Monitor ${s.id} (watch builds):`, "x".repeat(500), ...lines].join("\n").slice(0, 3000));
});

test("a budget of 10 notices refilled every 2 s; dropped ones are counted in the next; 30 s of suppression stops it as flooded", async (t) => {
  const s = await start(t);
  const head = `Monitor ${s.id} (watch builds)`;
  for (let i = 1; i <= 12; i++) await s.send(`event ${i}\n`);
  assert.deepEqual(s.notices, Array.from({ length: 10 }, (_, i) => `${head}:\nevent ${i + 1}`));
  assert.ok(s.timers.has(30_000), "suppression started");
  s.timers.fire(2000); // one notice back
  await s.send("event 13\n");
  assert.equal(s.notices.at(-1), `${head}: (2 earlier notices suppressed by the rate limit)\nevent 13`);
  assert.ok(s.timers.has(30_000), "a notice right after drops does not end the suppression");
  await s.send("event 14\n");
  const pgid = await s.pgid();
  s.timers.fire(30_000);
  await s.ended();
  await until(() => liveGroup(pgid).length === 0, "the command to be killed");
  assert.equal(s.notices.length, 12);
  assert.equal(s.notices.at(-1), `${head} failed [flooded]: its notices were suppressed for 30s. Tighten the command's filter so it prints fewer lines. Log: ${s.log}. Errors: ${s.log.replace(/\.log$/, ".err.log")}`);
  assert.deepEqual([fleet().get(s.id).status, fleet().get(s.id).result], ["failed", "flooded"]);
});

test("a notice with nothing dropped before it ends the suppression", async (t) => {
  const s = await start(t);
  for (let i = 1; i <= 11; i++) await s.send(`event ${i}\n`);
  assert.ok(s.timers.has(30_000));
  s.timers.fire(2000);
  await s.send("event 12\n"); // carries the drop count
  s.timers.fire(2000);
  await s.send("event 13\n"); // nothing dropped since
  assert.equal(s.timers.has(30_000), false);
  assert.equal(fleet().get(s.id).status, "running");
});

for (const [name, args, ui, seconds] of [
  ["the default deadline is 300 s", {}, false, 300],
  ["without the UI the deadline is at most 600 s", { timeout: 1000 }, false, 600],
  ["with the UI the deadline is at most 1,800 s", { timeout: 99999 }, true, 1800],
]) {
  test(`${name}; at the deadline it stops as failed with code timeout`, async (t) => {
    const s = await start(t, args, { ui });
    assert.match(s.result, new RegExp(`after ${seconds}s\\.`));
    const pgid = await s.pgid();
    s.timers.fire(seconds * 1000);
    await s.ended();
    await until(() => liveGroup(pgid).length === 0, "the command to be killed");
    assert.equal(s.notices.at(-1), `Monitor ${s.id} (watch builds) failed [timeout]: it reached its ${seconds}s deadline. Log: ${s.log}. Errors: ${s.log.replace(/\.log$/, ".err.log")}`);
    assert.deepEqual([fleet().get(s.id).status, fleet().get(s.id).result], ["failed", "timeout"]);
  });
}

test("a bad timeout is refused", async (t) => {
  const s = await start(t);
  const tool = s.session.extensionRunner.getToolDefinition("monitor");
  await assert.rejects(tool.execute("c2", { command: "true", description: "x", timeout: 0 }, undefined, undefined, {}), { message: "timeout must be a positive number of seconds" });
});

test("stop from FleetView sends SIGKILL to the group 800 ms after SIGTERM, with one notice", async (t) => {
  const s = await start(t, { command: `trap '' TERM; exec sh ${SCRIPT}` });
  const pgid = await s.pgid();
  const stopped = s.item.stop();
  assert.ok(s.timers.has(800));
  assert.notDeepEqual(liveGroup(pgid), [], "SIGTERM is ignored");
  s.timers.fire(800);
  await settles(stopped, "the stop to finish");
  await until(() => liveGroup(pgid).length === 0, "SIGKILL to reach the group");
  assert.deepEqual(s.notices, [`Monitor ${s.id} (watch builds) stopped. Log: ${s.log}. Errors: ${s.log.replace(/\.log$/, ".err.log")}`]);
  assert.equal(fleet().get(s.id).status, "stopped");
});

test("session shutdown kills the monitor without a notice", async (t) => {
  const s = await start(t);
  const pgid = await s.pgid();
  await settles(s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), "the shutdown");
  assert.deepEqual(liveGroup(pgid), []);
  assert.equal(fleet().get(s.id).status, "stopped");
  assert.deepEqual(s.notices, []);
});
