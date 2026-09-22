// Command-surface proof for extensions/commands/index.ts.
// Fakes the pi/ctx boundary (no pi runtime needed) and drives every
// retained slash command through its registered handler, asserting the
// observable UI effect (notification or session action).
import { describe, it } from "node:test";
import assert from "node:assert";
import factory from "../extensions/commands/index.ts";

const EXPECTED = [
  "clear",
  "theme",
  "agents",
  "tasks",
  "bg",
  "jobs",
  "skills",
  "intercom",
  "usage",
  "context",
  "ponytail",
  "kit",
  "skill:ponytail-review",
];

function makePi(skillCommands = []) {
  const commands = new Map();
  return {
    commands,
    on() {},
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getCommands() {
      return [
        { name: "clear", source: "extension" },
        ...skillCommands.map((name) => ({ name, source: "skill" })),
        { name: "prompt-cmd", source: "prompt" },
      ];
    },
  };
}

function makeCtx(overrides = {}) {
  const notifications = [];
  const calls = { newSession: 0, setTheme: [] };
  return {
    notifications,
    calls,
    ui: {
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
    },
    sessionManager: { getEntries: () => new Array(3).fill({}) },
    getSystemPrompt: () => "x".repeat(100),
    getContextUsage: () => ({ tokens: 500, contextWindow: 200000, percent: 1 }),
    setTheme: (name) => {
      calls.setTheme.push(name);
      return name === "dark" ? { success: true } : { success: false };
    },
    newSession: async () => {
      calls.newSession += 1;
      return { cancelled: false };
    },
    ...overrides,
  };
}

const last = (ctx) => ctx.notifications[ctx.notifications.length - 1];

describe("commands surface", () => {
  it("factory registers only the retained surface, synchronously", () => {
    const pi = makePi();
    const returned = factory(pi);
    assert.ok(!(returned instanceof Promise), "factory must be synchronous");
    assert.deepEqual([...pi.commands.keys()].sort(), [...EXPECTED].sort());
    for (const name of EXPECTED) {
      assert.equal(typeof pi.commands.get(name).handler, "function", `/${name} has a handler`);
    }
  });

  it("/clear starts a new session", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("clear").handler("", ctx);
    assert.equal(ctx.calls.newSession, 1);
  });

  it("/theme switches with args, shows usage without", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("theme").handler("dark", ctx);
    assert.match(last(ctx).message, /switched to dark/);
    await pi.commands.get("theme").handler("nope", ctx);
    assert.equal(last(ctx).type, "error");
    await pi.commands.get("theme").handler("  ", ctx);
    assert.match(last(ctx).message, /Usage/);
  });

  it("empty-state commands notify", async () => {
    const pi = makePi();
    factory(pi);
    for (const [name, pattern] of [
      ["agents", /No active subagents/],
      ["tasks", /No active tasks/],
      ["bg", /No background processes/],
      ["jobs", /No background jobs/],
      ["intercom", /No intercom peers/],
    ]) {
      const ctx = makeCtx();
      await pi.commands.get(name).handler("", ctx);
      assert.match(last(ctx).message, pattern, `/${name}`);
    }
  });

  it("/skills lists only skill-source commands", async () => {
    const pi = makePi(["skill-a", "skill-b"]);
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("skills").handler("", ctx);
    assert.match(last(ctx).message, /skill-a/);
    assert.match(last(ctx).message, /skill-b/);
    assert.doesNotMatch(last(ctx).message, /prompt-cmd/);

    const empty = makeCtx();
    const pi2 = makePi();
    factory(pi2);
    await pi2.commands.get("skills").handler("", empty);
    assert.match(last(empty).message, /No skills installed/);
  });

  it("/usage reports context tokens, /context reports session shape", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("usage").handler("", ctx);
    assert.match(last(ctx).message, /500 tokens/);
    await pi.commands.get("context").handler("", ctx);
    assert.match(last(ctx).message, /3 session entries/);
    assert.match(last(ctx).message, /100 chars/);

    const unknown = makeCtx({ getContextUsage: () => undefined });
    await pi.commands.get("usage").handler("", unknown);
    assert.match(last(unknown).message, /unknown/);
  });

  it("/ponytail shows a default, sets a validated mode, and isolates sessions", async () => {
    const pi = makePi();
    factory(pi);
    // Fresh session starts at the default regardless of execution order.
    const first = makeCtx();
    await pi.commands.get("ponytail").handler("", first);
    assert.match(last(first).message, /full/);
    await pi.commands.get("ponytail").handler("ultra", first);
    assert.match(last(first).message, /ultra/);
    await pi.commands.get("ponytail").handler("bogus", first);
    assert.equal(last(first).type, "error");
    await pi.commands.get("ponytail").handler("", first);
    assert.match(last(first).message, /ultra/);
    // A second session is unaffected by the first.
    const second = makeCtx();
    await pi.commands.get("ponytail").handler("", second);
    assert.match(last(second).message, /full/);
  });

  it("/kit lists unimplemented topics and resolves known/unknown topics", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("kit").handler("", ctx);
    assert.match(last(ctx).message, /not yet implemented/);
    assert.match(last(ctx).message, /diagnostics/);
    await pi.commands.get("kit").handler("diagnostics", ctx);
    assert.match(last(ctx).message, /not yet implemented/);
    await pi.commands.get("kit").handler("nope", ctx);
    assert.equal(last(ctx).type, "error");
  });

  it("/skill:ponytail-review is labeled unimplemented", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await pi.commands.get("skill:ponytail-review").handler("", ctx);
    assert.match(last(ctx).message, /not yet implemented/);
  });
});
