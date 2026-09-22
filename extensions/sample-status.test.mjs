// Load + cleanup proof for extensions/sample-status.ts.
// Fakes the pi/ctx boundary (no pi runtime needed) and drives the
// session_start -> session_shutdown lifecycle, including a repeated
// shutdown to prove idempotent cleanup.
import { describe, it } from "node:test";
import assert from "node:assert";
import factory from "./sample-status.ts";

function makePi() {
  const handlers = {};
  return {
    handlers,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
  };
}

function makeCtx() {
  const status = new Map();
  return {
    status,
    ui: {
      setStatus(id, text) {
        if (text === undefined) status.delete(id);
        else status.set(id, text);
      },
    },
  };
}

describe("sample-status", () => {
  it("registers sync setup only and cleans up idempotently on shutdown", async () => {
    const pi = makePi();
    const returned = factory(pi);
    // Factory rules: registration + cheap sync setup, so never async.
    assert.ok(!(returned instanceof Promise), "factory must be synchronous");
    assert.ok(pi.handlers["session_start"], "handles session_start");
    assert.ok(pi.handlers["session_shutdown"], "handles session_shutdown");

    const ctx = makeCtx();
    await pi.handlers["session_start"][0]({ reason: "startup" }, ctx);
    assert.equal(ctx.status.get("sample-status"), "sample-status: active");

    await pi.handlers["session_shutdown"][0]({}, ctx);
    assert.ok(!ctx.status.has("sample-status"), "status cleared on shutdown");

    // Idempotent: second shutdown is a safe no-op.
    await pi.handlers["session_shutdown"][0]({}, ctx);
    assert.ok(!ctx.status.has("sample-status"), "still cleared after repeat");
  });
});
