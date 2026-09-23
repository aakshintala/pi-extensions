// The monitor tool (#50) in scripted SDK sessions, which run without the UI. The watch
// command is tests/fixtures/monitor/batches.sh: it prints each batch when the test writes
// it, so the test controls what arrives together. Notices are read from the fleet
// registry's delivery for the session, and every timer is a fake the test fires.
import "./fixtures/tool-display/pi-tui.mjs"; // lets the extension modules load in plain node
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { liveGroup } from "./helpers/tui.mjs";
import { fleet } from "../shared/fleet/index.ts";
import { MAX_GROUPS, MAX_OUTPUT_BYTES, setGroupLimit, tooManyJobs } from "../shared/process-groups/index.ts";
import { rigSettings } from "../shared/settings/index.ts";

// The process's one settings instance, pinned to a directory this file owns, for the jobs extension.
const settingsDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-monitor-settings-")));
rigSettings(settingsDir);
after(() => rmSync(settingsDir, { recursive: true, force: true }));

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

/**
 * A fake clock for the monitor extension's timers. `advance(ms)` moves it forward, running
 * each timer that falls due, in order, including timers those set.
 */
function fakeClock(t) {
  let now = 0;
  const pending = new Set();
  let zombieWaits = 0;
  globalThis[TIMERS] = {
    setTimeout: (fn, ms) => {
      if (ms === 10) return (zombieWaits++, setTimeout(fn, ms)); // a killed group's zombie wait runs in real time
      const h = { fn, ms, at: now + ms };
      pending.add(h);
      return h;
    },
    clearTimeout: (h) => pending.delete(h),
  };
  const clock = {
    /** The lengths of the pending timers, in ms. */
    pending: () => [...pending].map((h) => h.ms).sort((a, b) => a - b),
    zombieWaits: () => zombieWaits,
    advance(ms) {
      const end = now + ms;
      for (let h; (h = [...pending].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0]); ) {
        pending.delete(h);
        now = h.at;
        h.fn();
      }
      now = end;
    },
  };
  // Runs before the session's shutdown. A kill grace still pending (Linux counts a group of
  // unreaped zombies as alive) ends now; the shutdown's own kills then use real timers.
  t.after(() => {
    clock.advance(800);
    delete globalThis[TIMERS];
  });
  return clock;
}

/** Starts a session whose model calls monitor with `args` (command defaults to the fixture). */
async function start(t, args = {}, { ui = false, extensions = [], replies = [says("ok")] } = {}) {
  const clock = fakeClock(t);
  let cwd;
  t.after(() => {
    try {
      process.kill(-Number(readFileSync(join(cwd, "pgid"), "utf8")), "SIGKILL");
    } catch {}
  });
  let ctx;
  const capture = (pi) => pi.on("session_start", (_e, c) => (ctx = c));
  const s = await scriptedSession(t, { replies: [calls({ command: `sh ${SCRIPT}`, description: "watch builds", ...args }), ...replies], extensions: [path("../extensions/monitor/index.ts"), ...extensions, capture] });
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
  const item = fleet().get(id); // for FleetView's stop
  const log = /Log: (\S+)\. Errors/.exec(result)[1];
  let n = 0;
  let written = "";
  const head = `Monitor ${id} (watch builds)`;
  const over = () => notices.some((n) => n.startsWith(`${head} `));
  /** Prints `text` as one batch and waits until the monitor has read it, or has ended. */
  const send = async (text) => {
    n++;
    writeFileSync(join(cwd, "tmp"), text);
    renameSync(join(cwd, "tmp"), join(cwd, `m${n}`));
    written += text;
    await until(() => readFileSync(log, "utf8") === written || over(), `batch ${n} in the log`);
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
  const logs = `Log: ${log}. Errors: ${log.replace(/\.log$/, ".err.log")}`;
  /** Waits for the monitor's end notice. */
  const ended = async () => {
    await until(() => notices.some((n) => n.startsWith(`${head} `)), "the end notice");
    return notices.find((n) => n.startsWith(`${head} `));
  };
  return { ...s, clock, notices, result, id, item, log, send, exit, pgid, ended, over, head, logs };
}

test("each batch of lines is one notice with the description; stderr has its own log; the exit ends it", async (t) => {
  const s = await start(t);
  const errors = s.log.replace(/\.log$/, ".err.log");
  assert.equal(s.result, `Started monitor ${s.id}; its output lines arrive as notices until it ends or after 300s. ${s.logs}`);
  assert.equal(statSync(s.log).mode & 0o777, 0o600);
  await s.send("build 1 ok\nbuild 2 \x1b[31mfailed\x1b[0m\n");
  await s.send("build 3 ok\npartial");
  await s.send(" line");
  s.exit(3);
  await s.ended();
  assert.equal(readFileSync(errors, "utf8"), "to stderr\n");
  assert.deepEqual(s.notices, [
    `${s.head}:\nbuild 1 ok\nbuild 2 failed`,
    `${s.head}:\nbuild 3 ok`,
    `${s.head}:\npartial line`, // a last line with no newline, delivered at the end
    `${s.head} ended: its command exited with code 3. ${s.logs}`,
  ]);
});

test("lines are cut at 500 code points and a notice at 3,000", async (t) => {
  const s = await start(t);
  const long = "😀".repeat(700); // two UTF-16 units each
  const lines = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(450, "y"));
  await s.send(`${long}\n${lines.join("\n")}\n`);
  const [notice] = s.notices;
  assert.equal([...notice].length, 3000);
  assert.equal(notice, [...[`${s.head}:`, "😀".repeat(500), ...lines].join("\n")].slice(0, 3000).join(""));
});

test("a long unended line is cut early without breaking a sequence the chunk cut off", async (t) => {
  const s = await start(t);
  // Over 2,000 characters with no newline, mostly colour codes, ending inside an OSC
  // string; the rest of the line comes next.
  await s.send(`${"\x1b[31m".repeat(400)}abc\x1b]0;ti`);
  await s.send("tle\x07 end\n");
  assert.deepEqual(s.notices, [`${s.head}:\nabc end`]);
});

test("a long description is cut so the drop count and the lines survive the notice cut", async (t) => {
  const s = await start(t, { description: "d".repeat(5000) });
  const head = `Monitor ${s.id} (${"d".repeat(100)})`;
  for (let i = 1; i <= 11; i++) await s.send(`event ${i}\n`);
  s.clock.advance(2000);
  await s.send("event 12\n");
  assert.equal(s.notices.at(-1), `${head}: (1 earlier notices suppressed by the rate limit)\nevent 12`);
});

test("a budget of 10 notices refilled every 2 s; dropped ones are counted in the next", async (t) => {
  const s = await start(t);
  for (let i = 1; i <= 12; i++) await s.send(`event ${i}\n`);
  assert.deepEqual(s.notices, Array.from({ length: 10 }, (_, i) => `${s.head}:\nevent ${i + 1}`));
  s.clock.advance(1999);
  await s.send("event 13\n");
  s.clock.advance(1); // one notice back
  await s.send("event 14\n");
  assert.equal(s.notices.at(-1), `${s.head}: (3 earlier notices suppressed by the rate limit)\nevent 14`);
  await s.send("event 15\n");
  s.clock.advance(4000); // two back
  await s.send("event 16\n");
  await s.send("event 17\n");
  assert.deepEqual(s.notices.slice(-2), [`${s.head}: (1 earlier notices suppressed by the rate limit)\nevent 16`, `${s.head}:\nevent 17`]);
});

/** Sends a line every 100 ms for `ms`, until the monitor ends. Returns the clock time of the line it ended before, if it did. */
async function flood(s, from, ms) {
  for (let at = from; at < from + ms; at += 100) {
    await s.send(`tick ${at}\n`);
    if (s.over()) return at;
    s.clock.advance(100);
  }
}

test("a steady flood ends as flooded 30 s after its first drop, though a notice gets through every 2 s", async (t) => {
  const s = await start(t);
  const pgid = await s.pgid();
  const at = await flood(s, 0, 40_000);
  assert.equal(at, 31_000); // 10 notices, then the first drop at 1 s
  assert.equal(await s.ended(), `${s.head} failed [flooded]: it printed faster than the rate limit for 30s. Tighten the command's filter so it prints fewer lines. ${s.logs}`);
  assert.equal(s.notices.length, 10 + 15 + 1, "a refill every 2 s let 15 more through");
  await until(() => liveGroup(pgid).length === 0, "the command to be killed");
});

test("a burst, then quiet, ends normally, even after a notice that reports drops", async (t) => {
  const s = await start(t);
  for (let i = 1; i <= 11; i++) await s.send(`event ${i}\n`);
  s.clock.advance(2000);
  await s.send("event 12\n");
  assert.equal(s.notices.at(-1), `${s.head}: (1 earlier notices suppressed by the rate limit)\nevent 12`);
  s.clock.advance(60_000);
  s.exit(0);
  assert.equal(await s.ended(), `${s.head} ended: its command exited with code 0. ${s.logs}`);
});

test("20 s of flood, a 3 s gap, then 20 s more never floods", async (t) => {
  const s = await start(t);
  assert.equal(await flood(s, 0, 20_000), undefined);
  s.clock.advance(3000);
  assert.equal(await flood(s, 23_000, 20_000), undefined);
  s.exit(0);
  assert.equal(await s.ended(), `${s.head} ended: its command exited with code 0. ${s.logs}`);
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
    s.clock.advance(seconds * 1000 - 1);
    await s.send("still here\n");
    assert.deepEqual(s.notices, [`${s.head}:\nstill here`]);
    s.clock.advance(1);
    assert.equal(await s.ended(), `${s.head} failed [timeout]: it reached its ${seconds}s deadline. ${s.logs}`);
    await until(() => liveGroup(pgid).length === 0, "the command to be killed");
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
  s.clock.advance(799);
  assert.notDeepEqual(liveGroup(pgid), [], "SIGTERM is ignored");
  s.clock.advance(1);
  await settles(stopped, "the stop to finish");
  assert.deepEqual(liveGroup(pgid), []);
  assert.deepEqual(s.notices, [`${s.head} stopped. ${s.logs}`]);
});

test("after the command exits, what it left in its group that ignores SIGTERM is killed", async (t) => {
  const s = await start(t, { command: `echo $$ > pgid; (trap '' TERM; exec tail -f /dev/null) >/dev/null 2>&1 & echo started` });
  const pgid = await s.pgid();
  assert.equal(await s.ended(), `${s.head} ended: its command exited with code 0. ${s.logs}`);
  assert.equal(liveGroup(pgid).length, 1, "the tail ignores SIGTERM");
  s.clock.advance(800);
  await until(() => liveGroup(pgid).length === 0, "SIGKILL to reach the group");
});

test("session shutdown kills the monitor without a notice", async (t) => {
  const s = await start(t);
  const pgid = await s.pgid();
  const shutdown = s.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  s.clock.advance(800); // the kill grace, in case unreaped zombies keep the group alive (Linux)
  await settles(shutdown, "the shutdown");
  assert.deepEqual(liveGroup(pgid), []);
  assert.deepEqual(s.notices, []);
});

test("a monitor is tracked: a crash record, a place under the job cap, both released once its group is empty", async (t) => {
  setGroupLimit(1);
  t.after(() => setGroupLimit(MAX_GROUPS));
  const s = await start(t);
  const pgid = await s.pgid();
  const record = s.log.replace(/\.log$/, ".pid");
  assert.match(basename(dirname(record)), /^pi-monitor-/, "reap scans this directory");
  assert.equal(statSync(dirname(record)).mode & 0o777, 0o700);
  assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).pgid, pgid);
  const tool = s.session.extensionRunner.getToolDefinition("monitor");
  await assert.rejects(tool.execute("c2", { command: "true", description: "x" }, undefined, undefined, {}), {
    message: "Not started: 1 jobs and monitors are running, the most allowed. Wait for one or stop one with jobs, then retry.",
  });
  await settles(s.item.stop(), "the stop");
  assert.equal(existsSync(record), false, "the empty group is forgotten with its record");
  assert.equal(tooManyJobs(), undefined);
});

test("a monitor whose log passes 5 GB stops as failed and says why", async (t) => {
  const s = await start(t);
  truncateSync(s.log, MAX_OUTPUT_BYTES + 1); // sparse: nothing is written
  writeFileSync(join(s.cwd, "tmp"), "one more\n");
  renameSync(join(s.cwd, "tmp"), join(s.cwd, "m1"));
  assert.equal(await s.ended(), `${s.head} failed [output]: its output passed 5 GB. Tighten the command's filter. ${s.logs}`);
  assert.equal(s.notices.length, 1, "the batch past the cap is not delivered");
});

test("stop clears the rate and flood timers, and the SIGKILL wait runs on the extension's clock", async (t) => {
  const s = await start(t, { command: `trap '' TERM; exec sh ${SCRIPT}` });
  const pgid = await s.pgid();
  for (let i = 1; i <= 11; i++) await s.send(`event ${i}\n`); // the 11th is dropped: flood and gap timers
  assert.deepEqual(s.clock.pending(), [2000, 2000, 30_000, 300_000]);
  const stopped = s.item.stop();
  assert.deepEqual(s.clock.pending(), [800], "only the kill grace is left");
  s.clock.advance(800);
  await settles(stopped, "the stop to finish");
  assert.deepEqual(liveGroup(pgid), []);
  assert.ok(s.clock.zombieWaits() > 0, "the SIGKILL found the killed group before its processes were reaped");
});

test("jobs stop ends a monitor", async (t) => {
  let pgid;
  const stopIt = (context) => {
    const text = textOf(context.messages.at(-1));
    const id = /monitor (\w{8})/.exec(text)[1];
    pgid = JSON.parse(readFileSync(/Log: (\S+)\.log\./.exec(text)[1] + ".pid", "utf8")).pgid; // the crash record
    assert.notDeepEqual(liveGroup(pgid), []);
    return fauxAssistantMessage([fauxToolCall("jobs", { action: "stop", id })], { stopReason: "toolUse" });
  };
  const s = await start(t, {}, { extensions: [path("../extensions/jobs/index.ts")], replies: [stopIt, says("done")] });
  const results = s.session.messages.filter((m) => m.role === "toolResult").map(textOf);
  assert.deepEqual(results.slice(1), [`Monitor ${s.id} stopped.`]);
  assert.deepEqual(liveGroup(pgid), []);
  assert.equal(await s.ended(), `${s.head} stopped. ${s.logs}`);
});
