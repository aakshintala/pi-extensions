// tmux TUI tests for the message queue (ADR 0001: event-synchronised, full-screen asserts).
// The gate fixture holds the agent in a tool call until the test releases it, so input is
// typed while the agent works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveGroup, startTui } from "../../tests/helpers/tui.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;
const GATE = new URL("../../tests/fixtures/queue/gate.ts", import.meta.url).pathname;
const gateCall = [{ type: "toolCall", id: "g1", name: "gate", arguments: {} }];

async function start(t, replies) {
  const tui = await startTui(t, { extensions: [GATE, EXT], replies });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), [])); // runs after the helper's cleanup
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("gate_waiting");
  return tui;
}

const release = (tui) => writeFileSync(join(tui.cwd, "release-1"), "");

test("queue section above the editor; Option+Up/Down/X edit rows in Pi's editor and the draft comes back", async (t) => {
  const tui = await start(t, [gateCall, "Steered.", "Followed."]);
  tui.type("first");
  tui.keys("Enter"); // steering
  tui.type("second");
  tui.keys("M-Enter"); // follow-up
  tui.type("my draft");
  await tui.waitForScreen(`

 go



 gate


 Steering (1) · next turn
   first
 Follow-ups (1) · after the run
   second
── ● Working ───────────────────────────────────────────────────────────────────
my draft
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1






`);

  tui.keys("M-Up"); // the most recent row loads into the editor
  await tui.waitForScreen(`

 go



 gate


 Steering (1) · next turn
   first
 Follow-ups (1) · after the run
 › second
── ● Working ───────────────────────────────────────────────────────────────────
second
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1






`);

  tui.keys("M-Up", "M-Down");
  tui.type(" edited");
  tui.keys("Enter"); // saved in place; the draft is back
  await tui.waitForScreen(`

 go



 gate


 Steering (1) · next turn
   first
 Follow-ups (1) · after the run
   second edited
── ● Working ───────────────────────────────────────────────────────────────────
my draft
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1






`);

  tui.keys("M-Up", "M-Up", "M-x"); // delete "first"; "second edited" is selected
  await tui.waitForScreen(`

 go



 gate


 Follow-ups (1) · after the run
 › second edited
── ● Working ───────────────────────────────────────────────────────────────────
second edited
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1








`);

  tui.keys("Enter"); // saved; wait for it, or the release can deliver the row first and Enter submits the draft
  await tui.waitForScreen(`

 go



 gate


 Follow-ups (1) · after the run
   second edited
── ● Working ───────────────────────────────────────────────────────────────────
my draft
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1








`);

  release(tui);
  await tui.waitForEvent("agent_end", 2);
  await tui.waitForScreen(`

 go



 gate
 released


 Steered.


 second edited


 Followed.

────────────────────────────────────────────────────────────────────────────────
my draft
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑23 ↓7 R15 W24 CH39.4% 0.0%/128k (auto)                                harness-1

`);
});

test("Esc cancels an edit; Esc while working aborts and keeps the queue until the next prompt", async (t) => {
  const tui = await start(t, [gateCall, "Done.", "Again."]);
  tui.type("keep me");
  tui.keys("Enter");
  tui.type("/compact");
  tui.keys("Enter"); // a command row: nothing to compact, so only a notice later
  tui.type("draft");
  tui.keys("M-Up", "M-Up");
  tui.type(" and junk");
  await tui.waitForScreen(`

 go



 gate


 Steering (1) · next turn
 › keep me
 Follow-ups (1) · after the run
 ⚙ /compact · runs when idle
── ● Working ───────────────────────────────────────────────────────────────────
keep me and junk
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1






`);

  tui.keys("Escape");
  await tui.waitForScreen(`

 go



 gate


 Steering (1) · next turn
   keep me
 Follow-ups (1) · after the run
 ⚙ /compact · runs when idle
── ● Working ───────────────────────────────────────────────────────────────────
draft
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1






`);

  tui.keys("C-u", "Escape");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(`

 go



 gate
 released


 Error: This operation was aborted

 Steering (1) · paused
   keep me
 Follow-ups (1) · paused
 ⚙ /compact · runs when idle
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 0.0%/128k (auto)                                              harness-1



`);

  tui.type("resume");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end", 2);
  // Pi 0.87.1 prints its own red line for a manual compaction with nothing to do; no
  // public API can predict or suppress it (see the PR). The queue adds its notice and moves on.
  await tui.waitForScreen(`

 Error: This operation was aborted


 resume


 Done.


 keep me


 Again.

 Error: Compaction failed: Nothing to compact (session too small)

 Nothing to compact

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑27 ↓6 R22 W28 CH57.1% 0.0%/128k (auto)                                harness-1`);
});

test("/compact and /reload typed while the agent works wait for it, with no error or warning", async (t) => {
  const tui = await start(t, [gateCall, "Done."]);
  tui.type("/compact");
  tui.keys("Enter");
  tui.type("/reload");
  tui.keys("Enter");
  await tui.waitForScreen(`

 go



 gate


 Follow-ups (2) · after the run
 ⚙ /compact · runs when idle
 ⚙ /reload · runs when idle
── ● Working ───────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1







`);

  tui.type("draft kept"); // Pi's /reload clears the editor; the queue puts this back
  release(tui);
  await tui.waitForEvent("session_start", 2);
  await tui.waitForScreen(`

 go



 gate
 released


 Done.

 Reloaded keybindings, extensions, skills, prompts, themes, and context files

────────────────────────────────────────────────────────────────────────────────
draft kept
────────────────────────────────────────────────────────────────────────────────
~/cwd
↑13 ↓4 R2 W14 CH8.0% 0.0%/128k (auto)                                  harness-1





`);
});
