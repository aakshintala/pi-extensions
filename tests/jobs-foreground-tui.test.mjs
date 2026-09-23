// A foreground bash command in a real pi (#51): Esc kills it, Ctrl+B moves it to the
// background, and a steer submitted while it runs does too and is delivered as steering.
// Each command writes its group id to ./pgid, then blocks until stopped.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("../extensions/fleet/index.ts"), path("../extensions/jobs/index.ts"), path("../extensions/queue/index.ts"), path("./fixtures/jobs/clock.ts")];
const COLS = 100;
const COMMAND = "echo $$ > pgid; echo started; exec tail -f /dev/null";
const run = [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: COMMAND } }];

async function poll(ok, what) {
  const deadline = Date.now() + 10_000;
  let v;
  while (!(v = ok())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(10); // poll interval, not a sync point
  }
  return v;
}

/** Starts pi, submits "go" and waits until the command has written its group id. */
async function start(t, replies) {
  const tui = await startTui(t, { extensions: EXTENSIONS, cols: COLS, replies });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  tui.type("go");
  tui.keys("Enter");
  const file = join(tui.cwd, "pgid");
  tui.pgid = await poll(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n") && Number(readFileSync(file, "utf8")), "the command");
  t.after(() => assert.deepEqual(liveGroup(tui.pgid), [], "the command's group is gone"));
  assert.notDeepEqual(liveGroup(tui.pgid), []);
  return tui;
}

const ROWS = 24;
const BORDER = "─".repeat(COLS);
const WORKING = "── ● Working " + "─".repeat(COLS - 13);
const footer = (usage) => ["~/cwd", usage.padEnd(COLS - "harness-1".length) + "harness-1"];
// The chat, the editor's top border, what is under the editor, and the footer's usage line.
const screen = (chat, top, below, usage) => {
  const lines = [...chat, top, "", BORDER, ...below, ...footer(usage)];
  return "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");
};
const CHAT = ["", " go", "", "", ` ⏺ Bash(${COMMAND})`];
const RUNNING = screen([...CHAT, ""], WORKING, [" ctrl+b to run in background"], "↑2 ↓18 W2 CH0.0% 0.0%/128k (auto)");
const ROW = [" ● main", `   shell ${COMMAND} · 0s · started`];

/** The job ID and log path the result names, read off the screen once it shows. */
async function moved(tui) {
  const [, id, log] = await poll(() => /Moved to the background as job (\w{8})\. Log: (\S+)/.exec(tui.screen()), "the result on screen");
  return [`   ⎿  Moved to the background as job ${id}. Log: ${log}`, "      A notice arrives when it ends."];
}

test("Esc during a foreground command kills its group", async (t) => {
  const tui = await start(t, [run, "never reached"]);
  await tui.waitForScreen(RUNNING);
  tui.keys("Escape");
  await tui.waitForEvent("agent_end");
  const chat = [...CHAT, "   ⎿  Error: started", "", "", "      Command aborted", "", " Error: This operation was aborted", ""];
  await tui.waitForScreen(screen(chat, BORDER, [], "↑2 ↓18 W2 0.0%/128k (auto)"));
  assert.deepEqual(liveGroup(tui.pgid), []);
});

test("Ctrl+B moves a foreground command to the background; its result shows the job ID and log path", async (t) => {
  const tui = await start(t, [run, "backgrounded"]);
  await tui.waitForScreen(RUNNING);
  tui.keys("C-b");
  await tui.waitForEvent("agent_end");
  const chat = [...CHAT, ...(await moved(tui)), "", " backgrounded", ""];
  await tui.waitForScreen(screen(chat, BORDER, ROW, "↑55 ↓21 R2 W55 CH1.9% 0.1%/128k (auto)"));
  assert.notDeepEqual(liveGroup(tui.pgid), [], "the job keeps running");
});

test("a steer while a command runs moves it to the background and is delivered as steering, without an abort", async (t) => {
  const tui = await start(t, [run, "steered"]);
  await tui.waitForScreen(RUNNING);
  tui.type("hurry up");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  // The steer comes after the tool result and before the reply to it; nothing was aborted.
  const chat = [...CHAT, ...(await moved(tui)), "", "", " hurry up", "", "", " steered", ""];
  await tui.waitForScreen(screen(chat, BORDER, ROW, "↑58 ↓20 R2 W59 CH1.7% 0.1%/128k (auto)"));
  assert.deepEqual(tui.events().filter((e) => e === "agent_start"), ["agent_start"], "one run");
  assert.notDeepEqual(liveGroup(tui.pgid), [], "the job keeps running");
});
