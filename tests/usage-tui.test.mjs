// /usage in a real pi (#61, ADR 0001): graph and table views and period
// switching over fixture sessions, with the clock pinned to 2026-09-20 12:00
// in Asia/Kolkata (UTC+5:30) by tests/fixtures/usage/clock.ts.
import { test } from "node:test";
import assert from "node:assert";
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const ROWS = 36;
// Pads to the full pane. Each template starts with a newline, which waitForScreen drops.
const screen = (text) => text + "\n".repeat(ROWS + 1 - text.split("\n").length);

const GRAPH_ALL_TIME = screen(`


────────────────────────────────────────────────────────────────────────────────

Usage   [Graphs]  Table   [v]

 Today    This Week    Last Week    Last 30 Days   [All Time]

Cumulative cost · by provider

$36.0 ┤                                                                        ⡜
      │                                                                       ⡰⠁
      │                                                                      ⢠⠃
      │                                                                      ⡎
      │                                                                     ⡸  ⠈
$19.6 ┤                                                                    ⢰⠁
      │                                                                   ⢀⠇
      │                                                                   ⡜
      │                                                                  ⡰⠁
      │                                                              ⣀⣀⣀⣠⠃    ⢀⡠
      │⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉      ⣀⠔⠊⠁
   $0 ┤                                                                 ⠠⠒⠉
       Sep 10                           Sep 15                            Sep 20

▸ ● Total                       $36.0
  ● Tools                       $24.0 67%
  ● p1                           $7.0 19%
  ● p2                           $5.0 14%

[m] metric  [g] group  [c] cumul  [↑↓] filter  [q] close

────────────────────────────────────────────────────────────────────────────────
~/cwd
0.0%/128k (auto)                                                       harness-1`);

const GRAPH_TODAY = screen(`


────────────────────────────────────────────────────────────────────────────────

Usage   [Graphs]  Table   [v]

[Today]   This Week    Last Week    Last 30 Days    All Time

Cumulative cost · by provider

$31.0 ┤                                                                       ⢀⠎
      │                                                                      ⢀⠎
      │                                                                     ⢀⠎ ⢀
      │                                                                    ⢠⠊ ⢠⠃
      │                                                                   ⢠⠃ ⢠⠃
$16.9 ┤                                                                  ⢠⠃ ⢠⠃
      │                                                                 ⡰⠁ ⡰⠁
      │                                                                ⡔⠁ ⡰⠁
      │                                                              ⢀⠎  ⡰⠁
      │                                                             ⢠⠊⢀⡠⠒⠁
      │                                                            ⡰⡡⠔⠁
   $0 ┤⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠉
       00:00                             06:00                             12:00

▸ ● Total                       $31.0
  ● Tools                       $24.0 77%
  ● p1                           $7.0 23%

[m] metric  [g] group  [c] cumul  [↑↓] filter  [q] close

────────────────────────────────────────────────────────────────────────────────
~/cwd
0.0%/128k (auto)                                                       harness-1`);

const TABLE_TODAY = screen(`


────────────────────────────────────────────────────────────────────────────────

Usage    Graphs  [Table]  [v]

[Today]   This Week    Last Week    Last 30 Days    All Time
Compact view. Widen the terminal for more columns.

Provider / Model           Sessions     Msgs     Cost   Tokens
──────────────────────────────────────────────────────────────
▸ Tools                           1        -    $24.0       14
▸ p1                              1        3    $7.00       36
──────────────────────────────────────────────────────────────
Total                             1        3    $31.0       50

[Tab/←→] period  [↑↓] select  [Enter] expand  [v] view  [q] close

────────────────────────────────────────────────────────────────────────────────
~/cwd
0.0%/128k (auto)                                                       harness-1`);

const TABLE_EXPANDED = screen(`


────────────────────────────────────────────────────────────────────────────────

Usage    Graphs  [Table]  [v]

[Today]   This Week    Last Week    Last 30 Days    All Time
Compact view. Widen the terminal for more columns.

Provider / Model           Sessions     Msgs     Cost   Tokens
──────────────────────────────────────────────────────────────
▾ Tools                           1        -    $24.0       14
    summaries                     1        -    $24.0       14
▸ p1                              1        3    $7.00       36
──────────────────────────────────────────────────────────────
Total                             1        3    $31.0       50

[Tab/←→] period  [↑↓] select  [Enter] expand  [v] view  [q] close

────────────────────────────────────────────────────────────────────────────────
~/cwd
0.0%/128k (auto)                                                       harness-1`);

const CLOSED = screen(`

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
0.0%/128k (auto)                                                       harness-1`);

test("/usage shows the graph, switches period with Tab and view with v, expands a provider, and q closes", async (t) => {
  const tui = await startTui(t, { cols: 80, rows: ROWS, extensions: [root("tests/fixtures/usage/clock.ts"), root("extensions/usage/index.ts")] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  // The default session folder, <agentDir>/sessions; read when /usage runs.
  cpSync(root("tests/fixtures/usage/sessions"), join(dirname(tui.home), "agent", "sessions"), { recursive: true });

  tui.type("/usage");
  tui.keys("Enter");
  await tui.waitForScreen(GRAPH_ALL_TIME);
  tui.keys("Tab");
  await tui.waitForScreen(GRAPH_TODAY);
  tui.keys("v");
  await tui.waitForScreen(TABLE_TODAY);
  tui.keys("Enter");
  await tui.waitForScreen(TABLE_EXPANDED);
  tui.keys("q");
  await tui.waitForScreen(CLOSED);
});
