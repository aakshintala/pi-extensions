// tmux TUI tests for the todo widget (ADR 0001: event-synchronised, full-screen asserts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveGroup, startTui } from "../../tests/helpers/tui.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;
const CHILD = new URL("../../tests/fixtures/todo/subagent.ts", import.meta.url).pathname;
const call = (todos) => [{ type: "toolCall", id: "t1", name: "todo_write", arguments: { todos } }];

async function start(t, opts) {
  const tui = await startTui(t, opts);
  t.after(() => assert.deepEqual(liveGroup(tui.pid), [])); // runs after the helper's cleanup
  return tui;
}

async function send(tui, text, n) {
  tui.type(text);
  tui.keys("Enter");
  await tui.waitForEvent("agent_end", n);
}

test("widget: markers, one collapsed done line, overflow cap, hidden when cleared", async (t) => {
  const open = Array.from({ length: 9 }, (_, i) => ({ text: `step ${i + 1}`, status: i ? "pending" : "in_progress" }));
  const done = [{ text: "a", status: "completed" }, { text: "b", status: "completed" }];
  const tui = await start(t, { extensions: [EXT], replies: [call([...done, ...open]), "Planned.", call([]), "Cleared."] });

  await send(tui, "plan", 1);
  await tui.waitForScreen(`

 plan


 ⏺ TodoWrite
   ⎿  Todo list saved: 8 pending, 1 in_progress, 2 completed.

 Planned.

 ✔ 2 done
 ◼ step 1
 ◻ step 2
 ◻ step 3
 ◻ step 4
 ◻ step 5
 ◻ step 6
 ◻ step 7
 … 2 more
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑132 ↓109 R3 W133 CH1.1% 0.2%/128k (auto)                              harness-1
`);
  await send(tui, "clear", 2);
  await tui.waitForScreen(`

 plan


 ⏺ TodoWrite
   ⎿  Todo list saved: 8 pending, 1 in_progress, 2 completed.

 Planned.


 clear


 ⏺ TodoWrite
   ⎿  Todo list cleared: 0 pending, 0 in_progress, 0 completed.

 Cleared.

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑169 ↓117 R275 W170 CH70.7% 0.2%/128k (auto)                           harness-1
`);
});

test("widget: a fully completed list is hidden after the next prompt", async (t) => {
  const done = ["a", "b", "c"].map((text) => ({ text, status: "completed" }));
  const tui = await start(t, { extensions: [EXT], replies: [call(done), "All done.", "You're welcome."] });

  await send(tui, "finish", 1);
  await tui.waitForScreen(`

 finish


 ⏺ TodoWrite
   ⎿  Todo list saved: 0 pending, 0 in_progress, 3 completed.

 All done.

 ✔ 3 done
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑57 ↓34 R3 W57 CH2.7% 0.1%/128k (auto)                                 harness-1








`);
  await send(tui, "thanks", 2);
  await tui.waitForScreen(`

 finish


 ⏺ TodoWrite
   ⎿  Todo list saved: 0 pending, 0 in_progress, 3 completed.

 All done.


 thanks


 You're welcome.

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑65 ↓38 R60 W66 CH77.0% 0.1%/128k (auto)                               harness-1



`);
});

test("widget: a subagent session (rig.subagent entry) draws none", async (t) => {
  const tui = await start(t, { extensions: [CHILD, EXT], replies: [call([{ text: "child task", status: "in_progress" }]), "Working."] });

  await send(tui, "delegated", 1);
  await tui.waitForScreen(`

 delegated


 ⏺ TodoWrite
   ⎿  Todo list saved: 0 pending, 1 in_progress, 0 completed.

 Working.

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑43 ↓19 R4 W44 CH4.8% 0.1%/128k (auto)                                 harness-1









`);
});
