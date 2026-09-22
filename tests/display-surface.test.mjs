// Display extension surface (issue #9): registered lifecycle behavior plus
// the derived-state shapes behind every condensed display.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  readGitBranch,
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
  return {
    type: "message",
    timestamp: "2026-09-22T20:00:00.000Z",
    message: { role: "assistant", usage: { input, output, cost: { total: cost } } },
  };
}

function costless(input, output) {
  return {
    type: "message",
    timestamp: "2026-09-22T20:00:00.000Z",
    message: { role: "assistant", usage: { input, output } },
  };
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

async function fire(pi, event, ctx, payload = {}) {
  for (const fn of pi.handlers[event] ?? []) await fn(payload, ctx);
}

describe("display surface", () => {
  it("factory registers lifecycle only, synchronously: no commands, no tools", () => {
    const pi = makePi();
    const returned = factory(pi);
    assert.ok(!(returned instanceof Promise), "factory must be synchronous");
    assert.deepEqual(pi.registered.commands, [], "display adds no commands");
    assert.deepEqual(pi.registered.tools, [], "display adds no tools");
    for (const event of [
      "session_start",
      "model_select",
      "turn_end",
      "message_end",
      "tool_call",
      "tool_execution_start",
      "tool_execution_end",
      "session_compact",
      "session_compact_failed",
      "session_shutdown",
    ]) {
      assert.ok(pi.handlers[event], `handles ${event}`);
    }
  });

  it("session_start renders measured model, context, quota, usage, and stamp", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    const line = ctx.status.get("display");
    assert.match(line, /anthropic\/claude-opus/);
    assert.match(line, /12.5k tokens \(6%\)/);
    assert.match(line, /quota 188k\/200k/);
    assert.match(line, /↑3k ↓1.5k \$0\.05/);
    assert.match(line, /message/);
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

  it("tool hooks render a transient tool segment from the event payload", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    assert.ok(!ctx.status.get("display").includes("read a.ts"));
    await fire(pi, "tool_execution_start", ctx, { toolName: "read", args: { path: "a.ts" } });
    assert.match(ctx.status.get("display"), /read a\.ts/);
    await fire(pi, "tool_call", ctx, { toolName: "bash", input: { command: "ls" } });
    assert.match(ctx.status.get("display"), /\$ ls/);
    await fire(pi, "turn_end", ctx);
    assert.ok(!ctx.status.get("display").includes("$ ls"), "tool segment is transient");
  });

  it("compaction refresh keeps the footer on the post-compaction context", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    ctx.getContextUsage = () => ({ tokens: null, contextWindow: 200000, percent: null });
    await fire(pi, "session_compact", ctx);
    assert.ok(!ctx.status.get("display").includes("tokens"), "unmeasured context drops out");
    assert.match(ctx.status.get("display"), /anthropic\/claude-opus/);
    await fire(pi, "session_compact_failed", ctx);
    assert.match(ctx.status.get("display"), /anthropic\/claude-opus/);
  });

  it("clears the slot when values become unmeasured, never locking stale state", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await fire(pi, "session_start", ctx);
    assert.ok(ctx.status.has("display"));
    ctx.model = undefined;
    ctx.getContextUsage = () => undefined;
    ctx.sessionManager = { getBranch: () => [] };
    await fire(pi, "turn_end", ctx);
    assert.ok(!ctx.status.has("display"), "fully-unmeasured refresh clears the slot");
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
  it("summarizeUsage totals assistant usage, skipping noise; cost stays undefined until measured", () => {
    assert.deepEqual(summarizeUsage([assistant(100, 50, 0.5), assistant(200, 100, 0.25)]), {
      input: 300,
      output: 150,
      cost: 0.75,
      turns: 2,
    });
    assert.deepEqual(summarizeUsage([{ type: "message", message: { role: "user" } }, null, "x"]).turns, 0);
    assert.deepEqual(summarizeUsage(undefined), { input: 0, output: 0, cost: undefined, turns: 0 });
    assert.equal(summarizeUsage([costless(100, 50)]).cost, undefined);
  });

  it("usage omits the dollar segment until a cost is measured", () => {
    const line = deriveStatus(makeCtx({ sessionManager: { getBranch: () => [costless(3000, 1500)] } }));
    assert.match(line, /↑3k ↓1\.5k/);
    assert.ok(!line.includes("$"), "no invented $0.00");
  });

  it("compactCount formats at the k boundary", () => {
    assert.equal(compactCount(999), "999");
    assert.equal(compactCount(1500), "1.5k");
    assert.equal(compactCount(NaN), undefined);
  });

  it("formatModel / formatContextUsage return undefined when unmeasured; percent rounds", () => {
    assert.equal(formatModel({ provider: "a", id: "b" }), "a/b");
    assert.equal(formatModel(undefined), undefined);
    assert.equal(formatContextUsage({ tokens: null }), undefined);
    assert.equal(formatContextUsage({ tokens: 500, percent: null }), "500 tokens");
    assert.equal(formatContextUsage({ tokens: 12500, percent: 6.7 }), "12.5k tokens (7%)");
  });

  it("formatQuota renders measured headroom, undefined otherwise", () => {
    assert.equal(formatQuota({ remaining: 3000, limit: 10000 }), "quota 3k/10k");
    assert.equal(formatQuota({ remaining: 3000 }), "quota 3k");
    assert.equal(formatQuota(undefined), undefined);
    assert.equal(formatQuota(null), undefined);
    assert.equal(formatQuota({}), undefined);
    assert.equal(formatQuota({ limit: 10000 }), undefined);
  });

  it("readGitBranch measures the branch, following worktree pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "display-git-"));
    assert.equal(readGitBranch(join(root, "missing")), undefined);
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/9-display\n");
    assert.equal(readGitBranch(repo), "feat/9-display");
    writeFileSync(join(repo, ".git", "HEAD"), "d34db33fd34db33fd34db33fd34db33fd34db33f\n");
    assert.equal(readGitBranch(repo), "detached");
    const real = join(root, "real");
    mkdirSync(join(real, ".git"), { recursive: true });
    writeFileSync(join(real, ".git", "HEAD"), "ref: refs/heads/main\n");
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(real, ".git")}\n`);
    assert.equal(readGitBranch(wt), "main");
    assert.equal(readGitBranch(undefined), undefined);
  });

  it("formatGitBranch renders only a measured branch", () => {
    assert.equal(formatGitBranch("main"), "(main)");
    assert.equal(formatGitBranch(null), undefined);
    assert.equal(formatGitBranch(undefined), undefined);
    assert.equal(formatGitBranch(""), undefined);
  });

  it("deriveStatus wires the git read into the live line", () => {
    const root = mkdtempSync(join(tmpdir(), "display-status-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const line = deriveStatus(makeCtx({ cwd: root }));
    assert.match(line, /\(main\)/);
    assert.ok(!deriveStatus(makeCtx()).includes("(main)"));
  });

  it("formatStamp condenses entries, labels unknown shapes, reads ISO timestamps", () => {
    assert.equal(formatStamp({ type: "tool_call" }), "tool_call");
    assert.match(formatStamp({ type: "message", timestamp: 0 }), /^message · /);
    assert.match(formatStamp({ type: "message", timestamp: "2026-09-22T20:00:00.000Z" }), /^message · /);
    assert.equal(formatStamp({}), "unknown entry");
  });

  it("deriveStatus stamps the latest branch entry, omits when the branch is empty", () => {
    assert.match(deriveStatus(makeCtx()), /message/);
    const line = deriveStatus(makeCtx({ sessionManager: { getBranch: () => [] } }));
    assert.ok(line === undefined || !line.includes("unknown entry"));
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
