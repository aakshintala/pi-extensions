import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleet } from "./index.ts";

test("two separately loaded copies of the module share one registry", async () => {
  const a = await import("./index.ts?copy=a");
  const b = await import("./index.ts?copy=b");
  assert.notEqual(a.fleet, b.fleet); // really two module instances
  assert.equal(a.fleet(), b.fleet());
});

test("the id main is reserved for the main session's row", () => {
  const fleet = createFleet();
  const spec = { id: "main", kind: "agent", label: "x", activity: () => "", view: { log: "/dev/null" }, stop() {} };
  assert.throws(() => fleet.register(spec), /reserved/);
  assert.deepEqual(fleet.items(), []);
});

const job = (id, owner) => ({ id, owner, kind: "shell", label: id, activity: () => "", view: { log: "/dev/null" }, stop() {} });

test("a notice for an owner not attached yet is held until it attaches", () => {
  const fleet = createFleet();
  fleet.register(job("a", "s1"));
  fleet.notify("a", "early");
  const got = [];
  fleet.attach("s1", (n) => got.push(n.text));
  fleet.notify("a", "later");
  assert.deepEqual(got, ["early", "later"]);
});

test("notices for a detached owner are dropped until it attaches again", () => {
  const fleet = createFleet();
  fleet.register(job("a", "s1"));
  fleet.attach("s1", () => {})();
  fleet.notify("a", "after shutdown");
  const got = [];
  fleet.attach("s1", (n) => got.push(n.text));
  fleet.notify("a", "after reload");
  assert.deepEqual(got, ["after reload"]);
});

test("a sink that throws, such as a disposed session's, is detached", () => {
  const fleet = createFleet();
  fleet.register(job("a", "s1"));
  let calls = 0;
  fleet.attach("s1", () => {
    calls++;
    throw new Error("This extension ctx is stale");
  });
  fleet.notify("a", "one");
  fleet.notify("a", "two");
  assert.equal(calls, 1);
});
