// Display bundle surface (issue #9): registered lifecycle behavior plus
// the derived-state shapes behind every condensed display.
import { describe, it } from "node:test";
import assert from "node:assert";
import factory, {
  buildStatusLine,
  compactCount,
  deriveStatus,
  formatContextUsage,
  formatGitBranch,
  formatModel,
  formatQuota,
  formatStamp,
  formatToolCall,
  summarizeUsage,
} from "../extensions/display/index.ts";

function makePi() {
  const handlers = {};
  const registered = { commands: [], tools: [] };
  return {
    handlers,
    registered,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    registerCommand(name) {
      registered.commands.push(name);
    },
    registerTool(tool) {
      registered.tools.push(tool?.name ?? tool);
    },
  };
}

function assistant(input, output, cost) {
  return { type: "message", message: { role: "assistant", usage: { input, output, cost: { total: cost } } } };
}

function makeCtx(overrides = {}) {
  const status = new Map();
  return {
    status,
    ui: {
      setStatus(id, text) {
        if (text === undefined) status.delete(id);
        else status.set(id, text);
      },
    },
    model: { provider: "anthropic", id: "claude-opus" },
    getContextUsage: () => ({ tokens: 12500, contextWindow: 200000, percent: 6 }),
    sessionManager: { getBranch: () => [assistant(3000, 1500, 0.05), { type: "message", message: { role: "user" } }] },
    ...overrides,
  };
}

async function fire(pi, event, ctx) {
  for (const fn of pi.handlers[event] ?? []) await fn({}, ctx);
}

describe("display surface", () => {
  it("factory registers lifecycle only, synchronously: no commands, no tools", () => {
    const pi = makePi();
    const returned = factory(pi);
    assert.ok(!(returned instanceof Promise), "factory must be synchronous");
    assert.deepEqual(pi.registered.commands, [], "display adds no commands");
    assert.deepEqual(pi.registered.tools, [], "display adds no tools");
    assert.ok(pi.handlers["session_start"], "handles session_start");
    assert.ok(pi.handlers["model_select"], "handles model_select");
    assert.ok(pi.handlers["turn_end"], "handles turn_end");
    assert.ok(pi.handlers["session_shutdown"], "handles session_shutdown");
  });

  it("session_start renders measured model, context, and usage", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    const line = ctx.status.get("display");
    assert.match(line, /anthropic\/claude-opus/);
    assert.match(line, /12.5k tokens \(6%\)/);
    assert.match(line, /↑3k ↓1.5k \$0\.05/);
  });

  it("model_select and turn_end refresh from current ctx reads", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    ctx.model = { provider: "openai", id: "gpt-5" };
    await fire(pi, "model_select", ctx);
    assert.match(ctx.status.get("display"), /openai\/gpt-5/);
    ctx.sessionManager = { getBranch: () => [assistant(2000, 2000, 0.1)] };
    await fire(pi, "turn_end", ctx);
    assert.match(ctx.status.get("display"), /↑2k/);
  });

  it("omits unmeasured segments instead of inventing state", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx({
      model: undefined,
      getContextUsage: () => undefined,
      sessionManager: { getBranch: () => [] },
    });
    await fire(pi, "session_start", ctx);
    assert.ok(!ctx.status.has("display"), "empty measurement leaves the slot untouched");
  });

  it("survives hostile ctx reads without breaking the session", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx({
      getContextUsage: () => {
        throw new Error("mid-compaction");
      },
      sessionManager: {
        getBranch: () => {
          throw new Error("no session");
        },
      },
    });
    await fire(pi, "session_start", ctx);
    assert.match(ctx.status.get("display"), /anthropic\/claude-opus/);
  });

  it("shutdown clears idempotently, and sessions never share state", async () => {
    const pi = makePi();
    factory(pi);
    const a = makeCtx({ model: { provider: "p", id: "a" } });
    const b = makeCtx({ model: { provider: "p", id: "b" } });
    await fire(pi, "session_start", a);
    await fire(pi, "session_start", b);
    assert.match(a.status.get("display"), /p\/a/);
    assert.match(b.status.get("display"), /p\/b/);
    await fire(pi, "session_shutdown", a);
    assert.ok(!a.status.has("display"), "status cleared on shutdown");
    assert.match(b.status.get("display"), /p\/b/, "sibling session untouched");
    await fire(pi, "session_shutdown", a);
    assert.ok(!a.status.has("display"), "repeat shutdown is a safe no-op");
  });
});

describe("display derived state", () => {
  it("summarizeUsage totals assistant usage, skipping noise", () => {
    assert.deepEqual(summarizeUsage([assistant(100, 50, 0.5), assistant(200, 100, 0.25)]), {
      input: 300,
      output: 150,
      cost: 0.75,
      turns: 2,
    });
    assert.deepEqual(summarizeUsage([{ type: "message", message: { role: "user" } }, null, "x"]).turns, 0);
    assert.deepEqual(summarizeUsage(undefined), { input: 0, output: 0, cost: 0, turns: 0 });
  });

  it("compactCount formats at the k boundary", () => {
    assert.equal(compactCount(999), "999");
    assert.equal(compactCount(1500), "1.5k");
    assert.equal(compactCount(NaN), undefined);
  });

  it("formatModel / formatContextUsage return undefined when unmeasured", () => {
    assert.equal(formatModel({ provider: "a", id: "b" }), "a/b");
    assert.equal(formatModel(undefined), undefined);
    assert.equal(formatContextUsage({ tokens: null }), undefined);
    assert.equal(formatContextUsage({ tokens: 500, percent: null }), "500 tokens");
  });

  it("formatQuota renders measured headroom, labels the missing source", () => {
    assert.equal(formatQuota({ remaining: 3000, limit: 10000 }), "quota 3k/10k");
    assert.equal(formatQuota(undefined), undefined);
    assert.equal(formatQuota({}), "quota: not yet implemented");
  });

  it("formatGitBranch renders only a measured branch", () => {
    assert.equal(formatGitBranch("main"), "(main)");
    assert.equal(formatGitBranch(null), "");
    assert.equal(formatGitBranch(undefined), "");
  });

  it("formatStamp condenses entries, labels unknown shapes", () => {
    assert.equal(formatStamp({ type: "tool_call" }), "tool_call");
    assert.match(formatStamp({ type: "message", timestamp: 0 }), /^message · /);
    assert.equal(formatStamp({}), "unknown entry");
  });

  it("formatToolCall condenses known tools, names unknown ones", () => {
    assert.equal(formatToolCall("read", { path: "a.ts" }), "read a.ts");
    assert.equal(formatToolCall("bash", { command: "ls" }), "$ ls");
    assert.equal(formatToolCall("edit", { path: "b.ts" }), "edit b.ts");
    assert.equal(formatToolCall("write", {}), "write");
    assert.equal(formatToolCall("mystery", { huge: "x".repeat(500) }), "mystery");
    assert.equal(formatToolCall("", {}), "unknown tool");
  });

  it("buildStatusLine joins measured parts, undefined when empty", () => {
    assert.equal(buildStatusLine(["a", undefined, "", "b"]), "a · b");
    assert.equal(buildStatusLine([undefined]), undefined);
  });

  it("deriveStatus is a pure function of its inputs", () => {
    assert.equal(deriveStatus({}), undefined);
    assert.match(deriveStatus(makeCtx()), /claude-opus/);
  });
});
