// A background job in a real pi (#48): FleetView shows the running shells on one shared
// row, whose Enter opens a picker over the running shells and from there the log viewer,
// which follows the log; x on the shared row stops a shell chosen from a picker, and a
// finished shell leaves the rows at once. tests/fixtures/jobs/clock.ts holds running times at 0s.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("../extensions/fleet/index.ts"), path("../extensions/jobs/index.ts"), path("./fixtures/jobs/clock.ts")];
const ROWS = 24;
const BORDER = "─".repeat(80);
const FOOTER = ["~/cwd", "↑45 ↓16 R2 W46 CH2.2% 0.1%/128k (auto)                                 harness-1"];

// Fullscreen mode: the chat area on top; editor, FleetView and footer pinned to the bottom.
const screen = (chat, fleet) => {
  const dock = [BORDER, "", BORDER, ...fleet, ...FOOTER];
  return "\n" + [...chat, ...Array(ROWS - dock.length - chat.length).fill(""), ...dock].join("\n");
};
const KEYS = " Enter to view · x to stop · ctrl+x ctrl+k to stop all agents";
const view = (state, lines) => [` shell sh job.sh · ${state} · esc back`, ...lines.map((l) => ` ${l}`)];

/** Waits for a fragment to appear on the screen, where an exact screen would be brittle. */
async function waitForText(tui, text) {
  for (let i = 0; i < 100 && !tui.screen().includes(text); i++) await delay(20);
  assert.ok(tui.screen().includes(text), `expected ${text} in screen:\n${tui.screen()}`);
}

test("a job is FleetView's shells row; the picker opens its log viewer, x stops it from the picker, and the row leaves when it finishes", async (t) => {
  const tui = await startTui(t, {
    extensions: EXTENSIONS,
    args: ["--tui-mode", "fullscreen"],
    replies: [
      [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sh job.sh", run_in_background: true } }],
      "started",
      "noted", // the stop's notice starts a turn
    ],
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  // Prints a line, waits for the test, prints another, then runs until stopped.
  writeFileSync(join(tui.cwd, "job.sh"), "echo $$ > pgid\necho first\nuntil [ -e go ]; do sleep 0.05; done\necho second\nexec tail -f /dev/null\n");
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");

  // The result names a random job ID and log path: read them off the screen, then match it all.
  let found;
  const deadline = Date.now() + 10_000;
  while (!(found = /Started job (\w{8})\. Log: (\S+)/.exec(tui.screen()))) {
    assert.ok(Date.now() < deadline, `no job on screen:\n${tui.screen()}`);
    await delay(10); // poll interval, not a sync point
  }
  const [, id, log] = found;
  const chat = ["", " go", "", "", " ⏺ Bash(sh job.sh)", `   ⎿  Started job ${id}. Log: ${log}`, "      A notice arrives when it ends.", "", " started"];
  await tui.waitForScreen(screen(chat, [" ● main", "   1 shell running in background"]));

  tui.keys("Down"); // into FleetView: the keys line shows
  await tui.waitForScreen(screen(chat, ["›● main", "   1 shell running in background", KEYS]));

  // One running shell: the shared row's Enter opens a picker with only it.
  tui.keys("Down", "Enter");
  await waitForText(tui, "Running shells");
  assert.match(tui.screen(), new RegExp(`sh job.sh · ${id}`, "m"));
  tui.keys("Enter"); // the only running shell: its log viewer opens, focus stays on the row
  await tui.waitForScreen(screen(view("0s", ["first"]), ["   main", "›● 1 shell running in background", KEYS]));

  writeFileSync(join(tui.cwd, "go"), ""); // the viewer follows the new log line
  await tui.waitForScreen(screen(view("0s", ["first", "second"]), ["   main", "›● 1 shell running in background", KEYS]));

  const pgid = Number(readFileSync(join(tui.cwd, "pgid"), "utf8"));
  t.after(() => assert.deepEqual(liveGroup(pgid), [], "the job's own group is gone"));
  assert.notDeepEqual(liveGroup(pgid), []);

  tui.keys("Escape"); // leaves FleetView to the editor, still viewing
  await tui.waitForScreen(screen(view("0s", ["first", "second"]), ["   main", " ● 1 shell running in background"]));
  tui.keys("Escape"); // the second Esc closes the viewer
  await tui.waitForScreen(screen(chat, [" ● main", "   1 shell running in background"]));

  tui.keys("Down", "Down", "x"); // the shared shells row again: x opens a picker over the running shells
  await waitForText(tui, "Stop running shell");
  assert.match(tui.screen(), new RegExp(`sh job.sh · ${id}`, "m"));
  tui.keys("Enter"); // at once, with no confirmation
  await tui.waitForEvent("agent_end", 2); // the stop's notice starts a turn
  // The notice folds into the chat and the stopped shell leaves the rows at once; with only
  // the main row left, FleetView draws nothing.
  await tui.waitForScreen(
    screen([...chat, "", " ■ shell sh job.sh · stopped 0s", "   stopped", "", " noted", ""], []).replace(FOOTER[1], "↑72 ↓18 R47 W73 CH45.5% 0.1%/128k (auto)                               harness-1"),
  );
  assert.doesNotMatch(tui.screen(), /running in background/);
  assert.deepEqual(liveGroup(pgid), []);
});
