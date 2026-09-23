import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { compact, createQuotaClient, full, registerQuota } from "./quota.ts";

const FEED = {
  providers: [
    { id: "claude", tier: "Max", status: "healthy", quotas: [
      { label: "Session", percentRemaining: 78, resetText: "Resets in 57m", resetsAt: null, status: "healthy" },
      { label: "Weekly", percentRemaining: 76.4, status: "healthy" },
    ] },
    { id: "cursor", tier: "PRO", status: "healthy", quotas: [
      { label: "Monthly", percentRemaining: 20.8, resetText: "30320/38298 requests", status: "healthy" },
    ] },
    { id: "go", status: "depleted", quotas: [
      { label: "Monthly", percentRemaining: 0, resetsAt: new Date(Date.now() + 90 * 60_000 + 30_000).toISOString(), status: "depleted" },
    ] },
    { id: "gemini", unavailable: "not signed in", quotas: [] },
  ],
  disabledProviderIds: ["zai"],
};

// Loopback feed. `hold` parks requests until release() so tests control timing.
async function feedServer({ body = FEED, hold = false } = {}) {
  const parked = [];
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const reply = () => res.end(JSON.stringify(body));
    hold ? parked.push(reply) : reply();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    hits: () => hits,
    release: () => parked.splice(0).forEach((f) => f()),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

// Manual timers: nothing fires until the test says so.
function fakeTimers() {
  let id = 0;
  const timeouts = new Map(), intervals = new Map();
  return {
    timeouts, intervals,
    setTimeout: (f, ms) => (timeouts.set(++id, { f, ms }), id),
    clearTimeout: (i) => timeouts.delete(i),
    setInterval: (f, ms) => (intervals.set(++id, { f, ms }), id),
    clearInterval: (i) => intervals.delete(i),
    fireTimeouts: () => [...timeouts.values()].forEach((t) => t.f()),
    tick: () => [...intervals.values()].forEach((t) => t.f()),
  };
}

function client(srv, extra = {}) {
  return createQuotaClient({ port: () => srv.port, refreshMs: () => 60_000, timers: fakeTimers(), ...extra });
}

test("concurrent gets merge into one fetch", async (t) => {
  const srv = await feedServer({ hold: true });
  t.after(srv.close);
  const c = client(srv);
  const all = Promise.all([c.get(), c.get({ force: true }), c.get()]);
  await waitFor(() => srv.hits() === 1);
  srv.release();
  const [a, b, d] = await all;
  assert.equal(srv.hits(), 1);
  assert.equal(a.providers.length, 4);
  assert.equal(a, b);
  assert.equal(a, d);
});

test("cache-first: a fresh feed is served without fetching, a stale one refetches", async (t) => {
  const srv = await feedServer();
  t.after(srv.close);
  let now = 1_000;
  const c = client(srv, { now: () => now });
  await c.get();
  now += 59_000;
  await c.get();
  assert.equal(srv.hits(), 1);
  await c.get({ force: true });
  assert.equal(srv.hits(), 2);
  now += 60_000;
  await c.get();
  assert.equal(srv.hits(), 3);
});

test("a fetch that outlives its timeout resolves null", async (t) => {
  const srv = await feedServer({ hold: true });
  t.after(srv.close);
  const timers = fakeTimers();
  const c = client(srv, { timers });
  const p = c.get();
  await waitFor(() => srv.hits() === 1);
  assert.deepEqual([...timers.timeouts.values()].map((x) => x.ms), [8_000]);
  timers.fireTimeouts();
  assert.equal(await p, null);
  assert.equal(timers.timeouts.size, 0);
});

test("an unreachable server or a bad feed resolves null", async () => {
  const srv = await feedServer();
  await srv.close();
  assert.equal(await client(srv).get(), null);

  const bad = await feedServer({ body: { nope: 1 } });
  assert.equal(await client(bad).get(), null);
  await bad.close();
});

test("compact text: one line per provider, detail only where unhealthy", () => {
  assert.equal(
    compact(FEED.providers),
    [
      "claude (Max): session 78% · weekly 76%",
      "cursor (PRO): monthly 21% (30320/38298 requests)",
      "go: monthly 0% (depleted, resets 1h30m)",
      "gemini: unavailable, not signed in",
    ].join("\n"),
  );
  assert.match(full(FEED), /Monthly: 0% left, resets in 1h30m, depleted/);
  assert.match(full(FEED), /Disabled in QuotaBar: zai/);
});

// Fake pi: records handlers, tools and commands the way the runtime would call them.
function fakePi() {
  const handlers = {}, tools = {}, commands = {};
  return {
    handlers, tools, commands,
    on: (e, h) => (handlers[e] ??= []).push(h),
    registerTool: (t) => (tools[t.name] = t),
    registerCommand: (n, c) => (commands[n] = c),
    emit: (e, ev = {}, ctx = {}) => (handlers[e] ?? []).forEach((h) => h(ev, ctx)),
  };
}
const settings = (port) => ({ get: (k) => ({ quotaPort: port, quotaRefreshSeconds: 60 })[k] });

test("polling runs only while a TUI session is active, across reloads", async (t) => {
  const srv = await feedServer();
  t.after(srv.close);
  const timers = fakeTimers();

  const pi1 = fakePi();
  registerQuota(pi1, settings(srv.port), { timers });
  pi1.emit("session_start", { reason: "startup" }, { mode: "print" });
  assert.equal(timers.intervals.size, 0);
  pi1.emit("session_start", { reason: "startup" }, { mode: "tui" });
  pi1.emit("session_start", { reason: "startup" }, { mode: "tui" });
  assert.deepEqual([...timers.intervals.values()].map((x) => x.ms), [60_000]);
  await waitFor(() => srv.hits() === 1);
  timers.tick();
  await waitFor(() => srv.hits() === 2);

  // /reload: old runtime shuts down, a fresh factory run starts.
  pi1.emit("session_shutdown", { reason: "reload" });
  assert.equal(timers.intervals.size, 0);
  const pi2 = fakePi();
  registerQuota(pi2, settings(srv.port), { timers });
  pi2.emit("session_start", { reason: "reload" }, { mode: "tui" });
  assert.equal(timers.intervals.size, 1);

  // Session switch, then quit; a second shutdown is a no-op.
  pi2.emit("session_shutdown", { reason: "new" });
  pi2.emit("session_shutdown", { reason: "quit" });
  assert.equal(timers.intervals.size, 0);
});

test("shutdown aborts the in-flight fetch", async (t) => {
  const srv = await feedServer({ hold: true });
  t.after(srv.close);
  const pi = fakePi();
  const c = registerQuota(pi, settings(srv.port), { timers: fakeTimers() });
  const p = c.get();
  await waitFor(() => srv.hits() === 1);
  pi.emit("session_shutdown", { reason: "quit" });
  assert.equal(await p, null);
});

test("get_quotas and /quota share one client and report plainly", async (t) => {
  const srv = await feedServer();
  t.after(srv.close);
  const pi = fakePi();
  registerQuota(pi, settings(srv.port), { timers: fakeTimers() });
  const run = async (params) => (await pi.tools.get_quotas.execute("id", params)).content[0].text;

  assert.match(await run({}), /^claude \(Max\)[\s\S]*gemini/);
  assert.equal(await run({ provider: "cursor" }), "cursor (PRO): monthly 21% (30320/38298 requests)");
  assert.match(await run({ provider: "nope" }), /Unknown provider nope; known: claude, cursor, go, gemini/);
  const notes = [];
  await pi.commands.quota.handler("", { ui: { notify: (m, type) => notes.push([m, type]) } });
  assert.equal(notes[0][1], "info");
  assert.match(notes[0][0], /^claude \(Max\): healthy\n  Session: 78% left\n/);
  assert.equal(srv.hits(), 1);

  const deadPi = fakePi();
  registerQuota(deadPi, settings(srv.port), { timers: fakeTimers() });
  await srv.close();
  assert.equal((await deadPi.tools.get_quotas.execute("id", {})).content[0].text, `QuotaBar feed unavailable on port ${srv.port}; is QuotaBar.app running?`);
  await deadPi.commands.quota.handler("", { ui: { notify: (m, type) => notes.push([m, type]) } });
  assert.equal(notes[1][1], "warning");
});

// Polls the event loop for loopback I/O; returns as soon as cond holds.
async function waitFor(cond) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), "condition never held");
}
