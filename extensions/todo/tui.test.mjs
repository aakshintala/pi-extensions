// tmux TUI tests for the todo widget (ADR 0001: event-synchronised, full-screen asserts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveGroup, startTui } from "../../tests/helpers/tui.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;
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

test("widget: one compact row, click expands the capped list, hidden when cleared", async (t) => {
  const open = Array.from({ length: 9 }, (_, i) => ({ text: `step ${i + 1}`, status: i ? "pending" : "in_progress" }));
  const done = [{ text: "a", status: "completed" }, { text: "b", status: "completed" }];
  const tui = await start(t, { extensions: [EXT], replies: [call([...done, ...open]), "Planned.", call([]), "Cleared."] });

  await send(tui, "plan", 1);
  await tui.waitForScreen(`

 plan


 ⏺ TodoWrite
   ⎿  Todo list saved: 8 pending, 1 in_progress, 2 completed.

 Planned.

 ◼ step 1 · 8 pending · 2 done
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑132 ↓109 R3 W133 CH1.1% 0.2%/128k (auto)                              harness-1
\n\n\n\n\n\n\n\n`);
  tui.type("/todos");
  tui.keys("Enter");
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

test("widget: a fullscreen click expands and collapses the list", async (t) => {
  const todos = [{ text: "test", status: "in_progress" }, { text: "ship", status: "pending" }];
  const tui = await start(t, { extensions: [EXT], args: ["--tui-mode", "fullscreen"], replies: [call(todos), "Planned."] });
  await send(tui, "plan", 1);
  const compact = " ◼ test · 1 pending";
  const expanded = " ◻ ship";
  const until = async (text, present) => {
    const deadline = Date.now() + 20_000;
    while (tui.screen().includes(text) !== present) {
      if (Date.now() > deadline) throw new Error(tui.screen());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await until(compact, true);
  tui.click(4, tui.screen().split("\n").indexOf(compact) + 1);
  await until(expanded, true);
  tui.click(4, tui.screen().split("\n").indexOf(" ◼ test") + 1);
  await until(compact, true);
  await until(expanded, false);
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
