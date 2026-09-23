import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleet, MAX_HELD } from "./index.ts";

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

test("an owner that never attaches holds only its latest notices", () => {
  const fleet = createFleet();
  fleet.register(job("a", "s1"));
  for (let i = 0; i <= MAX_HELD; i++) fleet.notify("a", `n${i}`);
  const got = [];
  fleet.attach("s1", (n) => got.push(n.text));
  assert.equal(got.length, MAX_HELD);
  assert.equal(got[0], "n1");
});

test("the default notice is one clean line", () => {
  const fleet = createFleet();
  fleet.now = () => 0;
  fleet.register({ ...job("a", "s1"), label: "sc\u001b]0;pwned\u0007out\u001b[2J" });
  const got = [];
  fleet.attach("s1", (n) => got.push(n.text));
  fleet.finish("a", "failed", "exit 1\n\u001b[31mError: boom\u001b[0m");
  assert.deepEqual(got, ["shell scout (id a) failed after 0s: exit 1 Error: boom"]);
});

test("an owner's detach drops its foreground commands, and a detached owner's are ignored", () => {
  const fleet = createFleet();
  const detach = fleet.attach("s1", () => {});
  fleet.attach("s2", () => {});
  const called = [];
  fleet.foreground("s1", () => called.push("s1"));
  fleet.foreground("s2", () => called.push("s2"));
  detach();
  fleet.foreground("s1", () => called.push("late"));
  assert.equal(fleet.foregrounds(), 1);
  fleet.backgroundAll();
  assert.deepEqual(called, ["s2"]);
});

test("backgroundAll calls each command once from one snapshot and drops one that throws", () => {
  const fleet = createFleet();
  const called = [];
  fleet.foreground("s1", () => {
    called.push("bad");
    throw new Error("producer bug");
  });
  fleet.foreground("s1", () => {
    called.push("good");
    fleet.foreground("s1", () => called.push("added during the press"));
  });
  fleet.backgroundAll();
  assert.deepEqual(called, ["bad", "good"]);
  assert.equal(fleet.foregrounds(), 2); // "good" (not ended by its handler) and the new one
  fleet.backgroundAll();
  assert.deepEqual(called, ["bad", "good", "good", "added during the press"]);
});
