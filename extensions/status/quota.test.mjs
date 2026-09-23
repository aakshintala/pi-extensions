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
function settings(port) {
  const values = { quotaPort: port, quotaRefreshSeconds: 60 }, listeners = [];
  return {
    get: (k) => values[k],
    onChange: (l) => listeners.push(l),
    set: (k, v) => ((values[k] = v), listeners.forEach((l) => l(k, v))),
  };
}

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
  assert.match(notes[0][0], /^claude \(Max\): healthy\n  Session: 78% left, Resets in 57m, healthy\n  Weekly: 76% left, healthy\n/);
  assert.equal(srv.hits(), 1);

  const deadPi = fakePi();
  registerQuota(deadPi, settings(srv.port), { timers: fakeTimers() });
  await srv.close();
  assert.equal((await deadPi.tools.get_quotas.execute("id", {})).content[0].text, `QuotaBar feed unavailable on port ${srv.port}; is QuotaBar.app running?`);
  await deadPi.commands.quota.handler("", { ui: { notify: (m, type) => notes.push([m, type]) } });
  assert.equal(notes[1][1], "warning");
});

test("stop clears the aborted fetch so the next get fetches again", async (t) => {
  const srv = await feedServer({ hold: true });
  t.after(srv.close);
  const c = client(srv);
  const first = c.get();
  await waitFor(() => srv.hits() === 1);
  c.stop();
  const next = c.get();
  await waitFor(() => srv.hits() === 2);
  srv.release();
  assert.equal(await first, null);
  assert.equal((await next).providers.length, 4);
});

test("joining a shorter in-flight fetch extends it to the caller's timeout", async (t) => {
  const srv = await feedServer({ hold: true });
  t.after(srv.close);
  const timers = fakeTimers();
  const c = client(srv, { timers });
  const poll = c.get({ force: true, timeoutMs: 5_000 });
  const tool = c.get();
  c.get({ timeoutMs: 1_000 });
  assert.deepEqual([...timers.timeouts.values()].map((x) => x.ms), [8_000]);
  await waitFor(() => srv.hits() === 1);
  srv.release();
  assert.equal(await poll, await tool);
});

test("a failed refresh keeps the last good feed while it is fresh", async (t) => {
  const srv = await feedServer();
  let now = 0;
  const c = client(srv, { now: () => now });
  const good = await c.get();
  await srv.close();
  now = 30_000;
  assert.equal(await c.get({ force: true }), good);
  assert.equal(await c.get(), good);
  now = 60_000;
  assert.equal(await c.get({ force: true }), null);
});

test("an unhealthy bucket without a reset time shows only its status", () => {
  const p = { id: "x", quotas: [{ label: "Daily", percentRemaining: 10, status: "warning" }] };
  assert.equal(compact([p]), "x: daily 10% (warning)");
});

test("get_quotas text stays within ~100 tokens for any feed", async (t) => {
  const bucket = (i) => ({ label: `Bucket number ${i}`, percentRemaining: 50, resetText: "12345/67890 requests", status: "warning", resetsAt: null });
  const providers = Array.from({ length: 40 }, (_, i) => ({ id: `provider-${i}`, tier: "Enterprise", quotas: Array.from({ length: 5 }, (_, j) => bucket(j)) }));
  const big = compact(providers);
  assert.ok(big.length <= 400, `${big.length} chars`);
  assert.match(big, /^provider-0 [\s\S]*\n\+\d+ more; pass provider for one$/);
  const one = compact([{ id: "wide", quotas: Array.from({ length: 60 }, (_, j) => bucket(j)) }]);
  assert.ok(one.length <= 400 && one.endsWith("…"), `${one.length} chars`);

  const srv = await feedServer({ body: { providers } });
  t.after(srv.close);
  const pi = fakePi();
  registerQuota(pi, settings(srv.port), { timers: fakeTimers() });
  for (const params of [{}, { provider: "provider-3" }, { provider: "nope" }]) {
    const text = (await pi.tools.get_quotas.execute("id", params)).content[0].text;
    assert.ok(text.length <= 400, `${JSON.stringify(params)}: ${text.length} chars`);
  }
});

test("a new quotaRefreshSeconds restarts polling at the new interval", async (t) => {
  const srv = await feedServer();
  t.after(srv.close);
  const timers = fakeTimers();
  const s = settings(srv.port);
  const pi = fakePi();
  registerQuota(pi, s, { timers });
  s.set("quotaRefreshSeconds", 30);
  assert.equal(timers.intervals.size, 0);
  pi.emit("session_start", { reason: "startup" }, { mode: "tui" });
  s.set("quotaRefreshSeconds", 120);
  assert.deepEqual([...timers.intervals.values()].map((x) => x.ms), [120_000]);
  pi.emit("session_shutdown", { reason: "quit" });
});

test("an unparseable reset time is left out, not shown as soon", () => {
  const q = { label: "Daily", percentRemaining: 10, status: "warning", resetsAt: "not a date" };
  assert.equal(compact([{ id: "x", throttledUntil: "junk", quotas: [q] }]), "x: daily 10% (warning) [throttled, last known]");
  assert.equal(full({ providers: [{ id: "x", quotas: [q] }] }), "x\n  Daily: 10% left, warning");
});

test("a provider without a status has no dangling colon in /quota", () => {
  assert.equal(full({ providers: [{ id: "x", quotas: [] }] }), "x");
});

test("the provider filter ignores case", async (t) => {
  const srv = await feedServer();
  t.after(srv.close);
  const pi = fakePi();
  registerQuota(pi, settings(srv.port), { timers: fakeTimers() });
  const text = (await pi.tools.get_quotas.execute("id", { provider: "Claude" })).content[0].text;
  assert.equal(text, "claude (Max): session 78% · weekly 76%");
});

test("a new quotaPort applies to the next call, bypassing the cache", async (t) => {
  const a = await feedServer(), b = await feedServer();
  t.after(a.close);
  t.after(b.close);
  const s = settings(a.port);
  const pi = fakePi();
  registerQuota(pi, s, { timers: fakeTimers() });
  await pi.tools.get_quotas.execute("id", {});
  s.set("quotaPort", b.port);
  await pi.tools.get_quotas.execute("id", {});
  assert.deepEqual([a.hits(), b.hits()], [1, 1]);
});

// Polls the event loop for loopback I/O; returns as soon as cond holds.
async function waitFor(cond) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), "condition never held");
}
