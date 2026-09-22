// Structured return (issue #11): success + failure fixtures proving
// compact output with preserved full logs, parser resolution, and the
// tail fallback. Fakes pi/ctx; commands are real but tiny.
import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import factory, { applyParser, parseTap, resolveParser } from "../extensions/background/index.ts";

function makePi() {
  const tools = new Map();
  return {
    tools,
    on() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
}

const ctx = () => ({ cwd: tmpdir(), sessionManager: {}, signal: undefined });

function exe(pi, params) {
  return pi.tools.get("structured_return").execute("test-call", params, undefined, undefined, ctx());
}

async function rejectsWith(promise) {
  try {
    await promise;
  } catch (err) {
    return String(err?.message ?? err);
  }
  assert.fail("expected rejection");
}

function logPathOf(text) {
  const m = /Full log: (\S+)/.exec(text);
  assert.ok(m, `result names its log file:\n${text}`);
  return m[1];
}

const TAP_OK = `node -e "console.log('1..2'); console.log('ok 1 alpha'); console.log('ok 2 beta')"`;
const TAP_FAIL = `node -e "console.log('1..2'); console.log('ok 1 alpha'); console.log('not ok 2 beta'); process.exit(1)"`;

describe("structured return fixtures", () => {
  it("success fixture: compact TAP summary plus a full log on disk", async () => {
    const pi = makePi();
    factory(pi);
    const result = await exe(pi, { command: TAP_OK, parseAs: "tap" });
    const [text] = [result.content[0].text];
    assert.match(text, /TAP: 2\/2 passed/);
    assert.doesNotMatch(text, /line \d/);
    assert.equal(result.details.parser, "tap");
    const path = logPathOf(text);
    assert.ok(existsSync(path), "log file preserved");
    const full = readFileSync(path, "utf8");
    assert.match(full, /ok 1 alpha/);
    assert.match(full, /ok 2 beta/);
  });

  it("failure fixture: exit code and failing test named, log preserved", async () => {
    const pi = makePi();
    factory(pi);
    const message = await rejectsWith(exe(pi, { command: TAP_FAIL, parseAs: "tap" }));
    assert.match(message, /TAP: 1\/2 passed/);
    assert.match(message, /- beta/);
    assert.match(message, /Command exited with code 1/);
    const full = readFileSync(logPathOf(message), "utf8");
    assert.match(full, /not ok 2 beta/);
  });

  it("unknown parser falls back to tail with a note; default is tail", async () => {
    const pi = makePi();
    factory(pi);
    const fallback = await exe(pi, { command: TAP_OK, parseAs: "nope" });
    assert.match(fallback.content[0].text, /Unknown parser "nope", used tail\./);
    assert.match(fallback.content[0].text, /ok 1 alpha/);
    assert.equal(fallback.details.parser, "tail");
    const plain = await exe(pi, { command: `node -e "console.log('just lines')"` });
    assert.match(plain.content[0].text, /just lines/);
  });

  it("timeout kills, keeps the partial log, and reports", async () => {
    const pi = makePi();
    factory(pi);
    const message = await rejectsWith(
      exe(pi, { command: `node -e "setTimeout(() => {}, 30000)"`, timeout: 1 }),
    );
    assert.match(message, /Command timed out after 1 seconds/);
    assert.ok(existsSync(logPathOf(message)), "partial log preserved on timeout");
  });
});

describe("parser resolution", () => {
  it("tap counts and names failures; plan mismatch noted", () => {
    assert.equal(parseTap("1..2\nok 1 a\nok 2 b\n"), "TAP: 2/2 passed");
    assert.equal(
      parseTap("1..3\nok 1 a\nnot ok 2 b\nok 3 c\n"),
      "TAP: 2/3 passed\nFailed:\n- b",
    );
    assert.match(parseTap("1..5\nok 1 a\n"), /plan 1\.\.5/);
  });

  it("resolveParser honors tap and tail, notes unknowns", () => {
    assert.deepEqual(resolveParser(undefined), { name: "tail" });
    assert.deepEqual(resolveParser("tap"), { name: "tap" });
    assert.equal(resolveParser("nope").name, "tail");
    assert.match(resolveParser("nope").note, /Unknown parser/);
    assert.ok(applyParser("tail", "x").includes("x"));
    assert.match(applyParser("tap", "ok 1 a\n"), /1\/1 passed/);
  });
});
