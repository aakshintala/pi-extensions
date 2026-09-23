// Footer module tests: colours, usage bookkeeping, TTFT/TPS, the git dirty
// check's debounce, overlap and shutdown, and the quota fetch tap. Fake pi,
// fake timers, fake git; no sleeps.
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

const { footerLines, registerFooter, GIT_DEBOUNCE_MS } = await import("./footer.ts");
const { default: status } = await import("./index.ts");

// Colours show as <role>text</role>; dim stays plain so the text reads as on screen.
const THEME = { fg: (role, s) => (role === "dim" ? s : `<${role}>${s}</${role}>`) };
const flush = () => new Promise((r) => setImmediate(r));
const usage = (input, output, cacheRead = 0, cost = 0) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total: cost } });
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
  return {
    handlers,
    on: (name, fn) => (handlers[name] ??= []).push(fn),
    getThinkingLevel: () => "high",
    registerTool() {},
    registerCommand() {},
  };
}

// A TUI session driving the handlers `register(pi)` installed.
function session(pi, { trusted = true, mode = "tui", branch = [] } = {}) {
  const s = { renders: 0, getBranch: 0, component: undefined };
  const ctx = {
    mode,
    cwd: "/repo",
    isProjectTrusted: () => trusted,
    model: { id: "m1" },
    getContextUsage: () => ({ percent: 5 }),
    sessionManager: { getBranch: () => (s.getBranch++, branch), getCwd: () => "/repo" },
    ui: {
      notify() {},
      setFooter: (factory) =>
        (s.component = factory({ requestRender: () => s.renders++ }, THEME, { getGitBranch: () => "main", onBranchChange: () => () => {} })),
    },
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
  const snap = (over) => ({
    model: "m1", thinking: "xhigh", totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, contextPercent: 5, cwd: "~/r", branch: "main", dirty: true, feed: FEED, ...over,
  });
  const [top, bottom] = footerLines(snap({}), THEME);
  assert.equal(top, "<accent>m1</accent> <thinkingXhigh>xhigh</thinkingXhigh>  │  in 0 out 0 cache -- $0.000  │  <accent>ctx [█░░░░░░░░░] 5%</accent>");
  assert.equal(bottom, "~/r <accent>main</accent><warning>*</warning>  │  Q <text>claude 78%</text> · <warning>codex 30%</warning> · <error>cursor 10%</error>  │  TTFT -- · TPS --");
  assert.match(footerLines(snap({ contextPercent: 70 }), THEME)[0], /<warning>ctx \[███████░░░\] 70%<\/warning>$/);
  assert.match(footerLines(snap({ contextPercent: 90 }), THEME)[0], /<error>ctx \[█████████░\] 90%<\/error>$/);
  assert.match(footerLines(snap({ contextPercent: null }), THEME)[0], /│  ctx --$/);
  assert.equal(footerLines(snap({ feed: null, dirty: false }), THEME)[1], "~/r <accent>main</accent>  │  Q unavailable  │  TTFT -- · TPS --");
  assert.equal(footerLines(snap({ feed: undefined, branch: null }), THEME)[1], "~/r  │  TTFT -- · TPS --");
});

test("usage: counted from the branch at start and on compaction, then per message, never per draw", async () => {
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: usage(1000, 200, 3000, 0.5) } },
    { type: "compaction", usage: usage(500, 100) },
  ];
  const { s } = gitHarness({ branch, trusted: false });
  await s.emit("session_start");
  assert.match(s.lines()[0], /in 1\.5k out 300 cache 67% \$0\.500/);
  s.lines();
  s.lines();
  assert.equal(s.getBranch, 1, "draws do not rescan the session");

  await s.emit("message_end", { message: { role: "toolResult", usage: usage(2000, 0, 0, 0.25) } });
  await s.emit("message_end", { message: { role: "user" } });
  assert.match(s.lines()[0], /in 3\.5k out 300 cache 46% \$0\.750/);
  assert.equal(s.getBranch, 1);

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
  assert.equal(gits.length, 1, "checked once at start");
  assert.equal(gits[0].cwd, "/repo");
  gits[0].resolve(false);
  await flush();
  assert.doesNotMatch(s.lines()[1], /\*/);

  for (let i = 0; i < 3; i++) await s.emit("tool_execution_end");
  assert.equal(gits.length, 1, "nothing runs before the debounce");
  assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [GIT_DEBOUNCE_MS], "one timer for a burst");
  timers.fire();
  assert.equal(gits.length, 2);

  await s.emit("tool_execution_end");
  timers.fire();
  assert.equal(gits.length, 2, "no second git while one runs");
  const before = s.renders;
  gits[1].resolve(true);
  await flush();
  assert.match(s.lines()[1], /main<\/accent><warning>\*<\/warning>/);
  assert.ok(s.renders > before, "a result redraws the footer");
  assert.equal(gits.length, 3, "the request made during the run runs after it");

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

test("git never runs in an untrusted project or outside the TUI", async () => {
  for (const options of [{ trusted: false }, { mode: "print" }]) {
    const { timers, gits, s } = gitHarness(options);
    await s.emit("session_start");
    await s.emit("tool_execution_end");
    assert.equal(timers.pending.size, 0);
    assert.equal(gits.length, 0);
  }
  const { s } = gitHarness({ mode: "print" });
  await s.emit("session_start");
  assert.equal(s.component, undefined, "no footer outside the TUI");
});

test("the footer shows each feed the quota client fetches, and plainly says when QuotaBar is down", async () => {
  let reply = () => Response.json(FEED);
  const pi = fakePi();
  status(pi, { fetch: async () => reply(), gitDirty: async () => null });
  const s = session(pi, { trusted: false });
  try {
    await s.emit("session_start");
    const quotas = () => s.lines()[1].split("  │  ")[1];
    for (let i = 0; i < 20 && quotas()?.startsWith("TTFT"); i++) await flush();
    assert.equal(quotas(), "Q <text>claude 78%</text> · <warning>codex 30%</warning> · <error>cursor 10%</error>");

    reply = () => {
      throw new TypeError("fetch failed");
    };
    await s.emit("session_shutdown"); // a new session start polls afresh
    await s.emit("session_start");
    for (let i = 0; i < 20 && quotas() !== "Q unavailable"; i++) await flush();
    assert.equal(quotas(), "Q unavailable");
  } finally {
    await s.emit("session_shutdown");
  }
  // Quotas cost prompt tokens only through get_quotas: nothing shapes the prompt or context.
  for (const name of ["before_agent_start", "context", "input"]) assert.equal(pi.handlers[name], undefined, name);
});
