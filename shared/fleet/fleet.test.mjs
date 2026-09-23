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
