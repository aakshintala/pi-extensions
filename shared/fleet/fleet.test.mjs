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

test("backgroundAll(owner) backgrounds only that session's commands", () => {
  const fleet = createFleet();
  const called = [];
  fleet.foreground("s1", () => called.push("s1"));
  fleet.foreground("s2", () => called.push("s2"));
  fleet.backgroundAll("s2");
  assert.deepEqual(called, ["s2"]);
});

// Decay (#137), on the registry's clock and timer seams: `tick(s)` advances the clock and fires due timers.
function fake(fleet) {
  let now = 0;
  let n = 0;
  const pending = new Map();
  fleet.now = () => now;
  fleet.timers = { setTimeout: (fn, ms) => (pending.set(++n, { at: now + ms, fn }), n), clearTimeout: (id) => pending.delete(id) };
  return {
    pending,
    tick(s) {
      now += s * 1000;
      for (const [id, t] of [...pending]) if (t.at <= now && pending.delete(id)) t.fn();
    },
  };
}
const ids = (fleet) => fleet.items().map((i) => i.id);

test("a finished shell leaves 10 s after it finishes, and no timer runs while nothing has finished", () => {
  const fleet = createFleet();
  const clock = fake(fleet);
  fleet.register(job("a", "s1"));
  fleet.register(job("b", "s1"));
  clock.tick(100);
  assert.equal(clock.pending.size, 0);
  fleet.finish("a", "completed", "ok", null);
  clock.tick(5);
  fleet.finish("b", "failed", "exit 1", null);
  clock.tick(4.999);
  assert.deepEqual(ids(fleet), ["a", "b"]);
  clock.tick(0.001);
  assert.deepEqual(ids(fleet), ["b"]);
  clock.tick(5);
  assert.deepEqual(ids(fleet), []);
  assert.equal(clock.pending.size, 0);
});

test("finished agents and monitors also leave after 10 s", () => {
  const fleet = createFleet();
  const clock = fake(fleet);
  fleet.register({ ...job("a", "s1"), kind: "agent" });
  fleet.register({ ...job("m", "s1"), kind: "monitor" });
  fleet.finish("a", "completed", "ok", null);
  fleet.finish("m", "failed", "error", null);
  clock.tick(9.999);
  assert.deepEqual(ids(fleet), ["a", "m"]);
  clock.tick(0.001);
  assert.deepEqual(ids(fleet), []);
});

test("a viewed or selected item stays until it is left, then leaves 10 s later", () => {
  const fleet = createFleet();
  const clock = fake(fleet);
  fleet.register(job("a", "s1"));
  fleet.register(job("b", "s1"));
  fleet.viewing = "a";
  fleet.selected = "b";
  fleet.finish("a", "completed", "ok", null);
  fleet.finish("b", "completed", "ok", null);
  assert.equal(clock.pending.size, 0);
  clock.tick(300);
  assert.deepEqual(ids(fleet), ["a", "b"]);
  fleet.viewing = undefined;
  clock.tick(9.999);
  assert.deepEqual(ids(fleet), ["a", "b"]);
  clock.tick(0.001);
  assert.deepEqual(ids(fleet), ["b"]);
  fleet.selected = undefined;
  clock.tick(9.999);
  assert.deepEqual(ids(fleet), ["b"]);
  clock.tick(0.001);
  assert.deepEqual(ids(fleet), []);
});

test("a finished parent stays while a child or grandchild runs", () => {
  const fleet = createFleet();
  const clock = fake(fleet);
  fleet.register(job("p", "s1"));
  fleet.register({ ...job("c", "s1"), parentId: "p" });
  fleet.register({ ...job("g", "s1"), parentId: "c" });
  fleet.finish("p", "completed", "ok", null);
  fleet.finish("c", "completed", "ok", null);
  clock.tick(60);
  assert.deepEqual(ids(fleet), ["p", "c", "g"]);
  fleet.finish("g", "completed", "ok", null);
  clock.tick(30);
  assert.deepEqual(ids(fleet), []);
});
