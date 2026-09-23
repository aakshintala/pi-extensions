// Footer module tests: colours, text safety, usage and context bookkeeping,
// TTFT/TPS, the git dirty check's debounce, overlap and shutdown, per-instance
// state, and the quota mirror. Fake pi, fake timers, fake git; no sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../tests/fixtures/tool-display/pi-tui.mjs"; // before modules that draw with pi-tui

// Settings are a process-wide singleton rooted at the agent dir: keep it off ~/.pi.
const agentDir = mkdtempSync(join(tmpdir(), "pi-rig-status-footer-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));

const { footerLines, registerFooter, tokens, GIT_DEBOUNCE_MS } = await import("./footer.ts");
const { default: status } = await import("./index.ts");
const { rigSettings } = await import("../../shared/settings/index.ts");

// Colours show as <role>text</role>; dim stays plain so the text reads as on screen.
const THEME = { fg: (role, s) => (role === "dim" ? s : `<${role}>${s}</${role}>`) };
const flush = () => new Promise((r) => setImmediate(r));
// Waits a bounded number of event-loop turns for a condition (no timers involved).
async function settle(ok, what) {
  for (let i = 0; i < 100 && !ok(); i++) await flush();
  assert.ok(ok(), what);
}
const usage = (input, output, cacheRead = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total: cost } });
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const FEED = {
  providers: [
    { id: "claude", quotas: [{ label: "Session", percentRemaining: 78, status: "healthy" }] },
    { id: "codex", quotas: [{ label: "Weekly", percentRemaining: 30, status: "healthy" }] },
    { id: "cursor", quotas: [{ label: "Month", percentRemaining: 10, status: "low" }] },
    { id: "gone", unavailable: "logged out", quotas: [] },
  ],
};

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout: (fn, ms) => (pending.set(++id, { fn, ms }), id),
    clearTimeout: (i) => pending.delete(i),
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

function fakePi() {
  const handlers = {};
  const commands = {};
  return {
    handlers,
    commands,
    on: (name, fn) => (handlers[name] ??= []).push(fn),
    getThinkingLevel: () => "high",
    registerTool() {},
    registerCommand: (name, c) => (commands[name] = c),
  };
}

// A session driving the handlers `register(pi)` installed. ctx.cwd differs from
// the session's cwd on purpose: the footer must use the session's.
function session(pi, { trusted = true, mode = "tui", branch = [], gitBranch = "main", cwd = "/repo", model = "m1" } = {}) {
  const s = { renders: 0, getBranch: 0, contextUsage: 0, percent: 5, component: undefined, notes: [] };
  const ctx = {
    mode,
    cwd: "/launched-here",
    isProjectTrusted: () => trusted,
    model: { id: model },
    getContextUsage: () => (s.contextUsage++, { percent: s.percent }),
    sessionManager: { getBranch: () => (s.getBranch++, branch), getCwd: () => cwd },
    ui: {
      notify: (text) => s.notes.push(text),
      setFooter: (factory) => (s.component = s.mount(factory)),
    },
  };
  s.ctx = ctx;
  s.mount = (factory) => {
    const tui = { requestRender: () => s.renders++ };
    return factory(tui, THEME, { getGitBranch: () => gitBranch, onBranchChange: () => () => {} });
  };
  s.emit = async (type, event = {}) => {
    for (const fn of pi.handlers[type] ?? []) await fn({ type, ...event }, ctx);
  };
  s.lines = () => s.component.render(500);
  return s;
}

function gitHarness(options) {
  const pi = fakePi();
  const timers = fakeTimers();
  const gits = [];
  registerFooter(pi, { timers, gitDirty: (cwd, signal) => new Promise((resolve) => gits.push({ cwd, signal, resolve })) });
  return { pi, timers, gits, s: session(pi, options) };
}

test("colours: quota headroom, context fill, thinking level and the dirty mark", () => {
  const snap = (over) => ({ model: "m1", thinking: "xhigh", totals: ZERO, contextPercent: 5, cwd: "~/r", branch: "main", dirty: true, feed: FEED, ...over });
  const [top, bottom] = footerLines(snap({}), THEME);
  assert.equal(top, "<accent>m1</accent> <thinkingXhigh>xhigh</thinkingXhigh>  │  in 0 out 0 cache -- $0.000  │  <accent>ctx [█░░░░░░░░░] 5%</accent>");
  assert.equal(bottom, "~/r <accent>main</accent><warning>*</warning>  │  Q <text>claude 78%</text> · <warning>codex 30%</warning> · <error>cursor 10%</error>  │  TTFT -- · TPS --");
  assert.match(footerLines(snap({ contextPercent: 70 }), THEME)[0], /<warning>ctx \[███████░░░\] 70%<\/warning>$/);
  assert.match(footerLines(snap({ contextPercent: 90 }), THEME)[0], /<error>ctx \[█████████░\] 90%<\/error>$/);
  assert.match(footerLines(snap({ contextPercent: null }), THEME)[0], /│  ctx --$/);
  assert.equal(footerLines(snap({ feed: null, dirty: false }), THEME)[1], "~/r <accent>main</accent>  │  Q unavailable  │  TTFT -- · TPS --");
  assert.equal(footerLines(snap({ feed: undefined, branch: null }), THEME)[1], "~/r  │  TTFT -- · TPS --");
});

test("a quota just under a threshold takes the colour of its exact value, not of its rounded text", () => {
  const feed = { providers: [{ id: "a", quotas: [{ label: "x", percentRemaining: 19.6, status: "low" }] }, { id: "b", quotas: [{ label: "x", percentRemaining: 49.7, status: "healthy" }] }] };
  const bottom = footerLines({ totals: ZERO, contextPercent: 0, cwd: "~", branch: null, dirty: null, feed }, THEME)[1];
  assert.match(bottom, /Q <error>a 20%<\/error> · <warning>b 50%<\/warning>/);
});

test("an unknown thinking level draws in the off colour instead of throwing", () => {
  const known = /^thinking(Off|Minimal|Low|Medium|High|Xhigh|Max)$/;
  const strict = { fg: (role, s) => (role.startsWith("thinking") && !known.test(role) ? assert.fail(`unknown role ${role}`) : THEME.fg(role, s)) };
  const top = footerLines({ thinking: "turbo", totals: ZERO, contextPercent: 0, cwd: "~", branch: null, dirty: null }, strict)[0];
  assert.match(top, /^<thinkingOff>turbo<\/thinkingOff>/);
});

test("cwd, branch, model and provider ids are drawn as plain text", () => {
  const evil = "\x1b[31mred\x1b]0;title\x07\nx";
  const feed = { providers: [{ id: evil, quotas: [{ label: "x", percentRemaining: 90, status: "healthy" }] }] };
  const [top, bottom] = footerLines({ model: evil, totals: ZERO, contextPercent: 0, cwd: `~/${evil}`, branch: evil, dirty: null, feed }, THEME);
  assert.equal(top.split("  │  ")[0], "<accent>red x</accent>");
  assert.equal(bottom.split("  │  ").slice(0, 2).join("  │  "), "~/red x <accent>red x</accent>  │  Q <text>red x 90%</text>");
});

test("token counts switch unit where the rounded text does", () => {
  assert.deepEqual(
    [999, 1000, 9949, 9950, 9999, 10_000, 999_499, 999_500, 9_949_999, 9_950_000].map(tokens),
    ["999", "1.0k", "9.9k", "10k", "10k", "10k", "999k", "1.0M", "9.9M", "10M"],
  );
});

test("usage and context: counted at start, on compaction and per message, never per draw", async () => {
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: usage(1000, 200, 3000, 0.5) } },
    { type: "compaction", usage: usage(500, 100) },
  ];
  const { s } = gitHarness({ branch, trusted: false });
  await s.emit("session_start");
  assert.match(s.lines()[0], /in 1\.5k out 300 cache 67% \$0\.500  │  <accent>ctx \[█░░░░░░░░░\] 5%/);
  s.lines();
  s.lines();
  assert.equal(s.getBranch, 1, "draws do not rescan the session");
  assert.equal(s.contextUsage, 1, "draws do not rebuild the context");

  s.percent = 72;
  await s.emit("message_end", { message: { role: "toolResult", usage: usage(2000, 0, 0, 0.25) } });
  await s.emit("message_end", { message: { role: "user" } });
  assert.match(s.lines()[0], /in 3\.5k out 300 cache 46% \$0\.750  │  <warning>ctx \[███████░░░\] 72%/);
  assert.equal(s.getBranch, 1);
  assert.equal(s.contextUsage, 3);

  await s.emit("session_compact");
  assert.match(s.lines()[0], /in 1\.5k out 300/, "a recount replaces the running totals");
  assert.equal(s.getBranch, 2);
});

test("TTFT and TPS come from the last reply's timing", async () => {
  const pi = fakePi();
  let now = 0;
  registerFooter(pi, { now: () => now, gitDirty: async () => null });
  const s = session(pi, { trusted: false });
  await s.emit("session_start");
  now = 1000;
  await s.emit("before_provider_request", { payload: {} });
  now = 1250;
  await s.emit("message_update");
  assert.match(s.lines()[1], /TTFT 250ms · TPS --$/);
  now = 3250;
  await s.emit("message_update");
  await s.emit("message_end", { message: { role: "assistant", usage: usage(10, 100) } });
  assert.match(s.lines()[1], /TTFT 250ms · TPS 50\.0$/);
});

test("git: debounced after tool calls, never two at once, stopped by shutdown", async () => {
  const { timers, gits, s } = gitHarness();
  await s.emit("session_start");
  await settle(() => gits.length === 1, "checked once at start");
  gits[0].resolve(false);
  await flush();
  assert.doesNotMatch(s.lines()[1], /\*/);

  for (let i = 0; i < 3; i++) await s.emit("tool_execution_end");
  assert.equal(gits.length, 1, "nothing runs before the debounce");
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [GIT_DEBOUNCE_MS], "one timer for a burst");
  timers.fire();
  await settle(() => gits.length === 2);

  await s.emit("tool_execution_end");
  timers.fire();
  await flush();
  assert.equal(gits.length, 2, "no second git while one runs");
  const before = s.renders;
  gits[1].resolve(true);
  await settle(() => gits.length === 3, "the request made during the run runs after it");
  assert.match(s.lines()[1], /main<\/accent><warning>\*<\/warning>/);
  assert.ok(s.renders > before, "a result redraws the footer");

  await s.emit("tool_execution_end");
  assert.equal(timers.pending.size, 1);
  await s.emit("session_shutdown");
  assert.equal(timers.pending.size, 0, "shutdown clears the debounce timer");
  assert.ok(gits[2].signal.aborted, "shutdown aborts the running git");
  gits[2].resolve(false);
  await flush();
  assert.match(s.lines()[1], /\*/, "an aborted result is dropped");
  await s.emit("tool_execution_end");
  await s.emit("session_shutdown");
  assert.equal(timers.pending.size, 0);
  assert.equal(gits.length, 3);
});

test("git runs in the session's cwd, the one the footer shows", async () => {
  const { gits, s } = gitHarness({ cwd: "/work/tree" });
  await s.emit("session_start");
  await settle(() => gits.length === 1);
  assert.equal(gits[0].cwd, "/work/tree");
  assert.match(s.lines()[1], /^\/work\/tree <accent>main/);
  gits[0].resolve(false);
  await s.emit("session_shutdown");
});

test("a new session's git waits until the old git has exited, in this footer and in another", async () => {
  const { gits, s } = gitHarness();
  await s.emit("session_start");
  await settle(() => gits.length === 1);
  await s.emit("session_start"); // session replaced: the old git is aborted but may still be exiting
  assert.ok(gits[0].signal.aborted);
  const other = gitHarness(); // another instance, e.g. after /new or /reload
  await other.s.emit("session_start");
  await flush();
  await flush();
  assert.equal(gits.length + other.gits.length, 1, "no git starts while the old one runs");
  gits[0].resolve(null);
  await settle(() => other.gits.length === 1, "the other footer, queued first, runs once the old git exits");
  await flush();
  assert.equal(gits.length, 1, "and the replacement session waits its turn");
  other.gits[0].resolve(false);
  await settle(() => gits.length === 2, "then the replacement session checks");
  gits[1].resolve(false);
  await s.emit("session_shutdown");
  await other.s.emit("session_shutdown");
});

test("git never runs in an untrusted project or outside the TUI", async () => {
  for (const options of [{ trusted: false }, { mode: "print" }]) {
    const { timers, gits, s } = gitHarness(options);
    await s.emit("session_start");
    await s.emit("tool_execution_end");
    await flush();
    assert.equal(timers.pending.size, 0);
    assert.equal(gits.length, 0);
  }
  const { s } = gitHarness({ mode: "print" });
  await s.emit("session_start");
  assert.equal(s.component, undefined, "no footer outside the TUI");
});

test("a non-TUI session start stops the previous session's git", async () => {
  const { pi, timers, gits, s } = gitHarness();
  await s.emit("session_start");
  await settle(() => gits.length === 1);
  await s.emit("tool_execution_end");
  assert.equal(timers.pending.size, 1);
  const print = session(pi, { mode: "print" });
  await print.emit("session_start");
  assert.equal(timers.pending.size, 0, "the debounce timer is cleared");
  assert.ok(gits[0].signal.aborted, "the running git is aborted");
  gits[0].resolve(true);
  await print.emit("tool_execution_end");
  await flush();
  assert.equal(timers.pending.size, 0);
  assert.equal(gits.length, 1);
});

test("disposing an old footer component does not silence the new one", async () => {
  const pi = fakePi();
  const footer = registerFooter(pi, { gitDirty: async () => null });
  const s = session(pi, { trusted: false });
  await s.emit("session_start");
  const first = s.component;
  await s.emit("session_start"); // Pi mounts the new footer, then disposes the old one
  first.dispose();
  const before = s.renders;
  footer.quotas(FEED);
  assert.ok(s.renders > before, "the new footer still redraws");
});

test("two sessions in one process keep their own timing and usage", async () => {
  let now = 0;
  const [a, b] = [fakePi(), fakePi()];
  registerFooter(a, { now: () => now, gitDirty: async () => null });
  registerFooter(b, { now: () => now, gitDirty: async () => null });
  const [sa, sb] = [session(a, { trusted: false }), session(b, { trusted: false })];
  await sa.emit("session_start");
  await sb.emit("session_start");
  now = 1000;
  await sa.emit("before_provider_request");
  now = 5000;
  await sb.emit("before_provider_request");
  now = 5100;
  await sa.emit("message_update");
  await sb.emit("message_update");
  await sa.emit("message_end", { message: { role: "assistant", usage: usage(7, 1) } });
  assert.match(sa.lines()[1], /TTFT 4\.1s/);
  assert.match(sb.lines()[1], /TTFT 100ms/);
  assert.match(sa.lines()[0], /in 7 out 1/);
  assert.match(sb.lines()[0], /in 0 out 0/);
});

test("the footer mirrors the quota client: new feeds, failures, stale drops and port changes, and ignores a fetch the port change aborted", async () => {
  let clock = 0;
  let reply = () => Response.json(FEED);
  let fetches = 0;
  let tick;
  const quotaTimers = { ...fakeTimers(), setInterval: (fn) => ((tick = fn), 1), clearInterval() {} };
  const pi = fakePi();
  status(pi, { fetch: async (_url, init) => (fetches++, reply(init)), now: () => clock, quotaTimers, gitDirty: async () => null });
  const section = rigSettings(agentDir).sections().find((x) => x.name === "status");
  const s = session(pi, { trusted: false });
  const quotas = () => s.lines()[1].split("  │  ").find((p) => p.startsWith("Q"));
  const poll = async () => {
    const n = fetches;
    tick ? tick() : await s.emit("session_start"); // a TUI session start polls, then every tick
    await settle(() => fetches === n + 1);
    await flush();
    await flush();
  };
  const quota = async () => {
    await pi.commands.quota.handler("", s.ctx);
    return s.notes.at(-1);
  };
  try {
    await poll();
    const shown = "Q <text>claude 78%</text> · <warning>codex 30%</warning> · <error>cursor 10%</error>";
    assert.equal(quotas(), shown);

    reply = () => {
      throw new TypeError("fetch failed");
    };
    clock = 30_000;
    await poll();
    assert.equal(quotas(), shown, "a failure inside the refresh interval keeps the feed, as the client does");
    assert.match(await quota(), /^claude/, "/quota agrees");

    clock = 61_000;
    await poll();
    assert.equal(quotas(), "Q unavailable");
    assert.match(await quota(), /unavailable/, "/quota agrees");

    reply = () => Response.json(FEED);
    await poll();
    assert.equal(quotas(), shown);
    let aborted = false;
    reply = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => ((aborted = true), reject(new DOMException("aborted", "AbortError")))));
    const n = fetches;
    tick();
    await settle(() => fetches === n + 1, "a fetch is in flight");
    section.set("quotaPort", 9999);
    assert.equal(quotas(), undefined, "a port change clears the footer with the client's cache");
    await settle(() => aborted, "the port change aborts the fetch");
    await flush();
    await flush();
    assert.equal(quotas(), undefined, "the aborted fetch leaves the cleared cache alone");
  } finally {
    await s.emit("session_shutdown");
    section.reset("quotaPort");
  }
  // Quotas cost prompt tokens only through get_quotas: nothing shapes the prompt or context.
  for (const name of ["before_agent_start", "context", "input"]) assert.equal(pi.handlers[name], undefined, name);
});

test("a hung quota fetch that times out drops a stale feed from the footer, as the client does", async () => {
  let clock = 0;
  let mode = "ok";
  let fetches = 0;
  let tick;
  const timers = { ...fakeTimers(), setInterval: (fn) => ((tick = fn), 1), clearInterval() {} };
  const fetch = (_url, init) => {
    fetches++;
    if (mode === "ok") return Promise.resolve(Response.json(FEED));
    if (mode === "fail") return Promise.reject(new TypeError("fetch failed"));
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  };
  const pi = fakePi();
  status(pi, { fetch, now: () => clock, quotaTimers: timers, gitDirty: async () => null });
  const s = session(pi, { trusted: false });
  const quotas = () => s.lines()[1].split("  │  ").find((p) => p.startsWith("Q"));
  try {
    await s.emit("session_start");
    await settle(() => quotas()?.startsWith("Q <text>claude"), "first feed shown");

    mode = "hang";
    clock = 61_000; // the feed is now stale
    tick();
    await settle(() => fetches === 2);
    assert.match(quotas(), /^Q <text>claude/, "still shown while the fetch hangs");
    timers.fire(); // the client's 5 s timeout aborts the fetch
    await settle(() => quotas() === "Q unavailable", "the stale feed is dropped on timeout");
    mode = "fail";
    await pi.commands.quota.handler("", s.ctx);
    assert.match(s.notes.at(-1), /unavailable/, "/quota agrees");
  } finally {
    await s.emit("session_shutdown");
  }
});

test("a shut-down footer stops mirroring the quota client", async () => {
  let reply = () => Response.json(FEED);
  let clock = 0;
  const pi = fakePi();
  status(pi, { fetch: async () => reply(), now: () => clock, quotaTimers: { ...fakeTimers(), setInterval: () => 1, clearInterval() {} }, gitDirty: async () => null });
  const s = session(pi, { trusted: false });
  const quotas = () => s.lines()[1].split("  │  ").find((p) => p.startsWith("Q"));
  await s.emit("session_start");
  await settle(() => quotas()?.startsWith("Q <text>claude"), "first feed shown");
  const shown = quotas();
  await s.emit("session_shutdown");
  await s.emit("session_shutdown"); // idempotent
  reply = () => Promise.reject(new TypeError("fetch failed"));
  clock = 61_000;
  const renders = s.renders;
  await pi.commands.quota.handler("", s.ctx); // the client still fetches; the footer must not hear it
  assert.match(s.notes.at(-1), /unavailable/);
  assert.equal(quotas(), shown);
  assert.equal(s.renders, renders);
});
