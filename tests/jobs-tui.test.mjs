// A background job in a real pi (#48): its FleetView row, the live log viewer and
// stop from the viewer. tests/fixtures/jobs/clock.ts holds running times at 0s.
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
const view = (state, lines) => [` shell sh job.sh · ${state} · esc back · ctrl+q stop`, ...lines.map((l) => ` ${l}`)];

test("a job is a FleetView row; its viewer follows the log and stops it", async (t) => {
  const tui = await startTui(t, {
    extensions: EXTENSIONS,
    args: ["--tui-mode", "fullscreen"],
    replies: [[{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sh job.sh", run_in_background: true } }], "started", "noted"],
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
  await tui.waitForScreen(screen(chat, [" ● main", "   shell sh job.sh · 0s · first"]));

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(view("0s", ["first"]), ["   main", "›● shell sh job.sh · 0s · first"]));
  writeFileSync(join(tui.cwd, "go"), ""); // the viewer follows the new line
  await tui.waitForScreen(screen(view("0s", ["first", "second"]), ["   main", "›● shell sh job.sh · 0s · second"]));

  const pgid = Number(readFileSync(join(tui.cwd, "pgid"), "utf8"));
  t.after(() => assert.deepEqual(liveGroup(pgid), [], "the job's own group is gone"));
  assert.notDeepEqual(liveGroup(pgid), []);
  tui.keys("C-q");
  tui.type("y");
  await tui.waitForEvent("agent_end", 2); // the stop's notice starts a turn
  await tui.waitForScreen(
    screen(view("stopped 0s", ["first", "second"]), ["   main", "›● shell sh job.sh · stopped 0s · stopped"]).replace(FOOTER[1], "↑72 ↓18 R47 W73 CH45.5% 0.1%/128k (auto)                               harness-1"),
  );
  assert.deepEqual(liveGroup(pgid), []);
});
