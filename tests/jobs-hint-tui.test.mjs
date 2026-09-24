// The Ctrl+B hint on the running call (#139) in a real pi: while a foreground command
// can be backgrounded, its call shows outside the group summary with a dim hint
// line, and folds back into the summary when it ends, is killed or moves to the background.
// A running group shows its static ⏺ summary at once; the clock fixture makes Pi's own
// working indicator still.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = ["../extensions/fleet/index.ts", "../extensions/jobs/index.ts", "../extensions/tool-display/index.ts", "./fixtures/jobs/clock.ts"].map(path);
const COLS = 100;
const ROWS = 24;
const BORDER = "─".repeat(COLS);
const WORKING = "── ● Working " + "─".repeat(COLS - 13);
// Runs until the test creates ./done; writes its group id to ./pgid first.
const LONG = "echo $$ > pgid; until [ -e done ]; do sleep 0.05; done";
const bash = (command) => [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }];

async function poll(ok, what) {
  const deadline = Date.now() + 10_000;
  let v;
  while (!(v = ok())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(10); // poll interval, not a sync point
  }
  return v;
}

async function start(t, replies, keybindings) {
  const tui = await startTui(t, { extensions: EXTENSIONS, cols: COLS, rows: ROWS, args: ["--tools", "bash"], replies, keybindings });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  tui.type("go");
  tui.keys("Enter");
  return tui;
}

/** Waits until the long command has written its group id. */
async function started(t, tui) {
  const file = join(tui.cwd, "pgid");
  tui.pgid = await poll(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n") && Number(readFileSync(file, "utf8")), "the command");
  t.after(() => assert.deepEqual(liveGroup(tui.pgid), [], "the command's group is gone"));
}

// The chat, the editor's top border, the rows under the editor, and the footer's usage line.
const screen = (chat, top, below, usage) => {
  const lines = [...chat, top, "", BORDER, ...below, "~/cwd", usage.padEnd(COLS - "harness-1".length) + "harness-1"];
  return "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");
};
const GO = ["", " go", "", ""];

/**
 * Samples the rows between the editor's bottom border and the footer until the returned
 * function is called, which gives each distinct set seen. Nothing under the editor may
 * change height while a tool starts or stops (#139).
 */
function watchUnderEditor(tui) {
  const seen = new Set();
  let on = true;
  const sample = async () => {
    while (on) {
      const rows = tui.screen().split("\n");
      seen.add(JSON.stringify(rows.slice(rows.lastIndexOf(BORDER) + 1, rows.indexOf("~/cwd"))));
      await delay(10); // sampling interval, not a sync point
    }
  };
  const done = sample();
  return async () => {
    on = false;
    await done;
    return [...seen].map((s) => JSON.parse(s));
  };
}
const RUNNING = screen(
  [...GO, " ⏺ Ran 1 shell command", ` ⏺ Bash(${LONG})`, "   ⎿  ctrl+b to run in background", ""],
  WORKING, [], "↑2 ↓19 W2 CH0.0% 0.0%/128k (auto)",
);

test("the editor is the only animated working indicator while a tool runs", async (t) => {
  const tui = await start(t, [bash(LONG), "finished"]);
  await started(t, tui);
  const running = await poll(() => tui.screen().includes(WORKING) && tui.screen().includes("Ran 1 shell command") && tui.screen(), "the active tool and editor");
  assert.doesNotMatch(running, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "tool rows must not show a spin frame");
  writeFileSync(join(tui.cwd, "done"), "");
  await tui.waitForEvent("agent_end");
});

test("while a long command runs, its call shows outside the summary with the hint; once it ends it folds back in; the rows under the editor never change", async (t) => {
  const tui = await start(t, [bash(LONG), "finished"]);
  const under = watchUnderEditor(tui);
  await started(t, tui);
  await tui.waitForScreen(RUNNING);
  writeFileSync(join(tui.cwd, "done"), "");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(screen([...GO, " ⏺ Ran 1 shell command", "", " finished", ""], BORDER, [], "↑31 ↓21 R2 W31 CH3.3% 0.0%/128k (auto)"));
  assert.deepEqual(await under(), [[]], "no rows under the editor at any point");
});

test("after Ctrl+B the call folds into its summary and the job is listed in FleetView", async (t) => {
  const tui = await start(t, [bash(LONG), "backgrounded"]);
  await started(t, tui);
  await tui.waitForScreen(RUNNING);
  tui.keys("C-b");
  await tui.waitForEvent("agent_end");
  const row = [" ● main", "   1 shell running in background"]; // running shells share one row
  await tui.waitForScreen(screen([...GO, " ⏺ Ran 1 shell command", "", " backgrounded", ""], BORDER, row, "↑55 ↓22 R2 W55 CH1.9% 0.1%/128k (auto)"));
  writeFileSync(join(tui.cwd, "done"), ""); // lets the job end before shutdown checks its group
});

test("Esc during a hinted run kills the command and leaves no hint", async (t) => {
  const tui = await start(t, [bash(LONG), "never reached"]);
  await started(t, tui);
  await tui.waitForScreen(RUNNING);
  tui.keys("Escape");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(screen([...GO, " ⏺ Ran 1 shell command", "", " Error: This operation was aborted", ""], BORDER, [], "↑2 ↓19 W2 0.0%/128k (auto)"));
  await poll(() => !liveGroup(tui.pgid).length, "the command's group to be gone"); // SIGKILL may follow SIGTERM by 800 ms
});

test("a fast command leaves no hint row", async (t) => {
  const tui = await start(t, [bash("echo hi"), "finished"]);
  const under = watchUnderEditor(tui);
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(screen([...GO, " ⏺ Ran 1 shell command", "", " finished", ""], BORDER, [], "↑17 ↓9 R2 W17 CH6.3% 0.0%/128k (auto)"));
  assert.deepEqual(await under(), [[]], "no rows under the editor at any point");
});

test("while Ctrl+B still moves the cursor left, a running call shows no hint", async (t) => {
  const tui = await start(t, [bash(LONG), "finished"], null); // Pi's default keybindings
  await started(t, tui);
  // FleetView's warning about Ctrl+B names a temporary path, so match rows, not the screen.
  await poll(() => tui.screen().includes(" ⏺ Ran 1 shell command\n\n── ● Working"), "the running summary");
  assert.ok(!tui.screen().includes("ctrl+b to run in background"), tui.screen());
  writeFileSync(join(tui.cwd, "done"), "");
  await tui.waitForEvent("agent_end");
});
