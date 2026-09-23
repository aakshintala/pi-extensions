// A monitor in a real pi (#50): its FleetView row, the live log viewer and stop from
// the viewer. tests/fixtures/jobs/clock.ts holds running times at 0s.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("../extensions/fleet/index.ts"), path("../extensions/monitor/index.ts"), path("./fixtures/jobs/clock.ts")];
const ROWS = 24;
// Token counts in the footer after each turn.
const USAGE = ["↑83 ↓18 R71 W84 CH70.4% 0.1%/128k (auto)", "↑97 ↓20 R154 W98 CH74.8% 0.1%/128k (auto)", "↑134 ↓20 R251 W136 CH56.4% 0.1%/128k (auto)"];
const BORDER = "─".repeat(80);
const FOOTER = (usage) => ["~/cwd", usage.padEnd(80 - "harness-1".length) + "harness-1"];

// Fullscreen mode: the viewer on top; editor, FleetView and footer pinned to the bottom.
const screen = (lines, fleet, usage) => {
  const view = [" monitor watch · " + lines.state + " · esc back · ctrl+q stop", ...lines.log.map((l) => ` ${l}`)];
  const dock = [BORDER, "", BORDER, ...fleet, ...FOOTER(usage)];
  return "\n" + [...view, ...Array(ROWS - dock.length - view.length).fill(""), ...dock].join("\n");
};

test("a monitor is a FleetView row; its viewer follows the log and stops it", async (t) => {
  const tui = await startTui(t, {
    extensions: EXTENSIONS,
    args: ["--tui-mode", "fullscreen"],
    replies: [[{ type: "toolCall", id: "c1", name: "monitor", arguments: { command: "sh watch.sh", description: "watch" } }], "started", "noted", "stopped"],
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  writeFileSync(join(tui.cwd, "watch.sh"), "echo $$ > pgid\necho first\nuntil [ -e go ]; do sleep 0.05; done\necho second\nexec tail -f /dev/null\n");
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end", 2); // the call's turn, then the notice for "first"

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen({ state: "0s", log: ["first"] }, ["   main", "›● monitor watch · 0s · first"], USAGE[0]));
  writeFileSync(join(tui.cwd, "go"), ""); // the viewer follows the new line
  await tui.waitForEvent("agent_end", 3); // its notice
  await tui.waitForScreen(screen({ state: "0s", log: ["first", "second"] }, ["   main", "›● monitor watch · 0s · second"], USAGE[1]));

  const pgid = Number(readFileSync(join(tui.cwd, "pgid"), "utf8"));
  t.after(() => assert.deepEqual(liveGroup(pgid), [], "the monitor's group is gone"));
  assert.notDeepEqual(liveGroup(pgid), []);
  tui.keys("C-q");
  tui.type("y");
  await tui.waitForEvent("agent_end", 4); // the stop's notice starts a turn
  await tui.waitForScreen(screen({ state: "stopped 0s", log: ["first", "second"] }, ["   main", "›● monitor watch · stopped 0s · stopped"], USAGE[2]));
  assert.deepEqual(liveGroup(pgid), []);
});
