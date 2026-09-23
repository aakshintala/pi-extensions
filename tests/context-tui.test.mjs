// /context in a real pi (#61, ADR 0001): the usage map and the injections
// inspector. The first view runs the silent probe, which must leave the
// transcript empty. tests/fixtures/context/stable-prompt.ts removes the
// machine-specific paths from the prompt so token counts match everywhere.
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const ROWS = 30;
// Pads to the full pane. Each template starts with a newline, which waitForScreen drops.
const screen = (text) => text + "\n".repeat(ROWS + 1 - text.split("\n").length);
const BORDER = "─".repeat(80);
const idle = (editor = "", below = []) =>
  screen(["", "", BORDER, editor, BORDER, ...below, "~/cwd", "0.9%/128k (auto)                                                       harness-1"].join("\n"));

const USAGE = screen(`
────────────────────────────────────────────────────────────────────────────────

Context Usage                                       harness-1 · 1.1k/128k (0.9%)

  ◧ ■ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Category:
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   → ■ System Prompt ........ 340     0.3%
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ■ Built-in Tools ....... 641     0.5%
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ⛝ Auto-Compact Buffer .. 16.4k   13%
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ⛶ Free Space ........... 110.6k  86%
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Map:
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ■ - Single category block
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ◧ - Shared block, largest category shown
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶     ⛶ - Block Size: 500 (0.4%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝
  ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝
  ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝




  Estimated context for the next model request. Token counts are approximate and
  may differ from the provider's estimate.

  ↑↓/jk Navigate · Enter Preview · Esc Close

────────────────────────────────────────────────────────────────────────────────`);

const INJECTIONS = screen(`
────────────────────────────────────────────────────────────────────────────────

Context Injections · [INITIAL]

→ pi ..................... 981
  ├─ System Prompt ....... 340
  │  ├─ Preamble ......... 43
  │  ├─ Available Tools .. 80
  │  ├─ Guidelines ....... 206
  │  ├─ Documentation .... 10
  │  └─ Current Dir ...... 1
  └─ Built-in Tools (4) .. 641
     ├─ edit ............. 278
     ├─ read ............. 154
     ├─ bash ............. 119
     └─ write ............ 90

  TOTAL .................. 981







  Injections into the model context for the first turn, with token estimates.

  ↑↓/jk Navigate · Enter Preview · Esc Close

────────────────────────────────────────────────────────────────────────────────`);

test("/context shows the usage map, /context injections the inspector, and the probe leaves no rows", async (t) => {
  const tui = await startTui(t, {
    cols: 80,
    rows: ROWS,
    extensions: [root("tests/fixtures/context/stable-prompt.ts"), root("extensions/context/index.ts")],
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));

  tui.type("/context");
  tui.keys("Enter");
  await tui.waitForScreen(USAGE);
  tui.keys("Escape");
  await tui.waitForScreen(idle());

  tui.type("/context injections");
  await tui.waitForScreen(idle("/context injections", ["→ injections                      Explore initial context injections"]));
  tui.keys("Enter"); // accepts the completion
  await tui.waitForScreen(idle("/context injections"));
  tui.keys("Enter");
  await tui.waitForScreen(INJECTIONS);
  tui.keys("Escape");
  await tui.waitForScreen(idle());
});
