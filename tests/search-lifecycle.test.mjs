// Index lifecycle against a minimal stand-in for Pi: cancel, "/" as cwd, the fallback notice,
// and cleanup on session switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { direct, spyFFF, tempRepo } from "./fixtures/search/setup.mjs";

const settle = () => new Promise(setImmediate);

test("cancelling a search ends its wait for the index", { timeout: 10_000 }, async (t) => {
  let waiting;
  const asked = new Promise((r) => (waiting = r));
  const spy = spyFFF({ waitForScan: () => (waiting(), new Promise(() => {})) });
  const s = direct(t, spy.load, { wait: () => new Promise(() => {}) });
  s.start(tempRepo(t));
  const cancel = new AbortController();
  const result = s.run("grep", { pattern: "login" }, cancel.signal);
  await asked;
  cancel.abort();
  await assert.rejects(result, /Operation aborted/);
});

test("a session in / never loads FFF", async (t) => {
  let loads = 0;
  const s = direct(t, async () => (loads++, spyFFF().FileFinder));
  s.start("/");
  const repo = tempRepo(t);
  assert.equal(await s.run("find", { pattern: "*.js", path: repo }), "lib/util.js");
  assert.equal(loads, 0);
});

test("the fallback notice shows once per session", async (t) => {
  const spy = spyFFF();
  spy.FileFinder.isAvailable = () => false;
  const s = direct(t, spy.load);
  s.start(tempRepo(t));
  await s.run("grep", { pattern: "login" });
  await s.run("find", { pattern: "*.js" });
  assert.equal(s.notices.length, 1);
  s.start(tempRepo(t)); // session switch
  await s.run("find", { pattern: "*.js" });
  assert.equal(s.notices.length, 2);
});

test("a session switch destroys the old index and opens one for the new cwd", async (t) => {
  const spy = spyFFF();
  const s = direct(t, spy.load);
  s.start(tempRepo(t));
  assert.equal(await s.run("find", { pattern: "*.js" }), "lib/util.js");
  const next = tempRepo(t);
  s.start(next); // Pi emits session_start for the new session
  await settle();
  assert.equal(spy.finders[0].isDestroyed, true);
  assert.equal(await s.run("find", { pattern: "*.md" }), "notes.md");
  assert.equal(spy.finders[1].isDestroyed, false);
  assert.deepEqual(spy.opts.map((o) => o.basePath).slice(-1), [next]);
  s.shutdown();
  await settle();
  assert.equal(spy.finders[1].isDestroyed, true);
});
