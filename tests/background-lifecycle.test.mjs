// Background lifecycle (issue #11): bash + jobs end to end through the
// registered tools — foreground run, background launch, list, output,
// wait, kill — plus the truncation units behind every compact result.
// Fakes the pi/ctx boundary (no pi runtime needed); child processes are
// real but tiny and deterministic (node -e one-liners).
import { describe, it } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import factory, {
  MAX_BYTES,
  MAX_LINES,
  createTools,
  formatOutput,
  tailTruncate,
} from "../extensions/background/index.ts";

function makePi() {
  const handlers = {};
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
}

function makeCtx() {
  return { cwd: tmpdir(), sessionManager: {}, signal: undefined };
}

function exe(pi, name, ctx, params) {
  return pi.tools.get(name).execute("test-call", params, undefined, undefined, ctx);
}

describe("background registration", () => {
  it("registers exactly bash, jobs, structured_return with a sync factory", () => {
    const pi = makePi();
    const returned = factory(pi);
    assert.ok(!(returned instanceof Promise), "factory must be synchronous");
    assert.deepEqual([...pi.tools.keys()].sort(), ["bash", "jobs", "structured_return"]);
    assert.ok(pi.handlers["session_shutdown"], "cleans up on session_shutdown");
    const bash = pi.tools.get("bash");
    assert.deepEqual(bash.parameters.required, ["command"]);
    assert.ok(bash.promptSnippet, "bash keeps its prompt snippet across the override");
  });
});

describe("bash/jobs lifecycle", () => {
  it("foreground run returns output; failures throw with the exit code", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    const ok = await exe(pi, "bash", ctx, { command: `node -e "console.log('hello-lifecycle')"` });
    assert.match(ok.content[0].text, /hello-lifecycle/);
    await assert.rejects(
      exe(pi, "bash", ctx, { command: `node -e "process.exit(3)"` }),
      /Command exited with code 3/,
    );
    await assert.rejects(exe(pi, "jobs", ctx, { action: "wait" }), /requires jobId/);
    await assert.rejects(exe(pi, "jobs", ctx, { action: "wait", jobId: "99" }), /Unknown job: 99/);
  });

  it("background launch, list, output, wait cover one job end to end", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    const empty = await exe(pi, "jobs", ctx, { action: "list" });
    assert.equal(empty.content[0].text, "No background jobs");

    const started = await exe(pi, "bash", ctx, {
      command: `node -e "setTimeout(() => console.log('bg-done'), 200)"`,
      run_in_background: true,
    });
    assert.match(started.content[0].text, /Started background job 1/);

    const listed = await exe(pi, "jobs", ctx, { action: "list" });
    assert.match(listed.content[0].text, /1 \[(running|exited 0)\]/);

    const out = await exe(pi, "jobs", ctx, { action: "output", jobId: "1" });
    assert.match(out.content[0].text, /Job 1 \[/);

    const done = await exe(pi, "jobs", ctx, { action: "wait", jobId: "1" });
    assert.match(done.content[0].text, /exited 0/);
    assert.match(done.content[0].text, /bg-done/);
  });

  it("wait timeout reports still-running; kill ends a sleeper", async () => {
    const pi = makePi();
    factory(pi);
    const ctx = makeCtx();
    await exe(pi, "bash", ctx, { command: `node -e "setTimeout(() => {}, 30000)"`, run_in_background: true });
    const pending = await exe(pi, "jobs", ctx, { action: "wait", jobId: "1", timeout: 0.05 });
    assert.match(pending.content[0].text, /still running/);

    const killed = await exe(pi, "jobs", ctx, { action: "kill", jobId: "1" });
    assert.match(killed.content[0].text, /Job 1 killed/);
    const after = await exe(pi, "jobs", ctx, { action: "wait", jobId: "1" });
    assert.match(after.content[0].text, /killed/);
    // Killing twice reports measured state, not an error.
    const again = await exe(pi, "jobs", ctx, { action: "kill", jobId: "1" });
    assert.match(again.content[0].text, /Job 1 killed/);
  });

  it("sessions never see each other's jobs; shutdown clears idempotently", async () => {
    const pi = makePi();
    factory(pi);
    const a = makeCtx();
    const b = makeCtx();
    await exe(pi, "bash", a, { command: `node -e "setTimeout(() => {}, 30000)"`, run_in_background: true });
    const bList = await exe(pi, "jobs", b, { action: "list" });
    assert.equal(bList.content[0].text, "No background jobs");

    await pi.handlers["session_shutdown"][0]({}, a);
    const aList = await exe(pi, "jobs", a, { action: "list" });
    assert.equal(aList.content[0].text, "No background jobs");
    // Idempotent: second shutdown is a safe no-op.
    await pi.handlers["session_shutdown"][0]({}, a);
    await pi.handlers["session_shutdown"][0]({}, b);
  });

  it("foreground timeout kills and reports", async () => {
    const pi = makePi();
    factory(pi);
    await assert.rejects(
      exe(pi, "bash", makeCtx(), { command: `node -e "setTimeout(() => {}, 30000)"`, timeout: 1 }),
      /Command timed out after 1 seconds/,
    );
  });
});

describe("tail truncation", () => {
  it("passes short output through", () => {
    const t = tailTruncate("a\nb\nc");
    assert.equal(t.truncated, false);
    assert.equal(t.truncatedBy, null);
    assert.equal(t.content, "a\nb\nc");
  });

  it("cuts lines first, keeping the tail", () => {
    const text = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
    const t = tailTruncate(text);
    assert.equal(t.truncated, true);
    assert.equal(t.truncatedBy, "lines");
    assert.equal(t.outputLines, MAX_LINES);
    assert.match(t.content, /line 2499$/);
    assert.doesNotMatch(t.content, /line 0\n/);
  });

  it("cuts bytes when lines fit", () => {
    const text = `${"x".repeat(1000)}\n${"y".repeat(1000)}`;
    assert.ok(Buffer.byteLength(text) < MAX_BYTES);
    const big = Array.from({ length: 60 }, () => "z".repeat(1000)).join("\n");
    const t = tailTruncate(big);
    assert.equal(t.truncated, true);
    assert.equal(t.truncatedBy, "bytes");
  });

  it("marks a lone giant line partial instead of dropping it", () => {
    const t = tailTruncate("z".repeat(MAX_BYTES + 100));
    assert.equal(t.truncated, true);
    assert.equal(t.lastLinePartial, true);
    assert.ok(t.content.length > 0);
  });

  it("formatOutput adds the log notice only when truncated", () => {
    const small = formatOutput({ tail: "hi", totalBytes: 2, totalLines: 1, overflowed: false });
    assert.equal(small.text, "hi");
    assert.equal(small.details.fullOutputPath, undefined);
    const big = formatOutput({
      tail: tailTruncate(Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n")).content,
      totalBytes: 20000,
      totalLines: 2500,
      overflowed: false,
      logPath: "/tmp/pi-test.log",
    });
    assert.match(big.text, /Full output: \/tmp\/pi-test\.log/);
    assert.equal(big.details.fullOutputPath, "/tmp/pi-test.log");
    assert.equal(big.details.truncation.totalLines, 2500);
  });

  it("createTools exposes the same defs the factory registers", () => {
    assert.deepEqual(
      createTools(new WeakMap()).map((t) => t.name).sort(),
      ["bash", "jobs", "structured_return"],
    );
  });
});
