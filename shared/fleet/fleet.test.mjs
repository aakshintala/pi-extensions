import { test } from "node:test";
import assert from "node:assert/strict";

test("two separately loaded copies of the module share one registry", async () => {
  const a = await import("./index.ts?copy=a");
  const b = await import("./index.ts?copy=b");
  assert.notEqual(a.fleet, b.fleet); // really two module instances
  assert.equal(a.fleet(), b.fleet());
});
