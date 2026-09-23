// Ctrl+B and its hint (#47) in a real pi. The test producer registers "background now"
// handlers; the fleet extension binds Ctrl+B only once keybindings.json frees it from
// Pi's default cursor-left binding. /reload re-reads keybindings.json.
import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSIONS = [
  fileURLToPath(new URL("../extensions/fleet/index.ts", import.meta.url)),
  fileURLToPath(new URL("./fixtures/fleet/producer.ts", import.meta.url)),
];
// Wide enough that the warning, which names a temporary path, fits on one row.
const COLS = 240;
const ROWS = 24;
const BORDER = "─".repeat(COLS);
const FOOTER = ["~/cwd", "0.0%/128k (auto)".padEnd(COLS - "harness-1".length) + "harness-1"];
const HINT = " ctrl+b to run in background";
const RELOADED = " Reloaded keybindings, extensions, skills, prompts, themes, and context files";

// The chat, the editor, what is under it, and the footer.
const screen = (chat, editor = "", below = []) => {
  const lines = [...chat, BORDER, editor, BORDER, ...below, ...FOOTER];
  return "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");
};

// `keybindings: null` starts pi with its default keybindings, which bind Ctrl+B to cursor left.
async function start(t, keybindings) {
  const tui = await startTui(t, { extensions: EXTENSIONS, cols: COLS, rows: ROWS, keybindings });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const file = join(dirname(tui.home), "agent", "keybindings.json");
  let n = 0;
  // Runs producer ops (tests/fixtures/fleet/producer.ts) and waits until they are applied.
  tui.fx = async (...ops) => {
    tui.type("/fx " + JSON.stringify(ops));
    tui.keys("Enter");
    await tui.waitForEvent("fx", ++n);
  };
  tui.warning = ["", ` Warning: Ctrl+B moves the cursor left, so it cannot background commands. Add "tui.editor.cursorLeft": ["left"] to ${file}`, ""];
  // Frees Ctrl+B in keybindings.json and reloads; wait for the reloaded screen before typing.
  tui.freeCtrlB = () => {
    writeFileSync(file, JSON.stringify({ "tui.editor.cursorLeft": ["left"] }));
    tui.type("/reload");
    tui.keys("Enter");
  };
  return tui;
}

test("while Ctrl+B moves the cursor left, one warning names the line to add and nothing is bound", async (t) => {
  const tui = await start(t, null);
  await tui.fx({ fg: "a" });
  tui.type("ab");
  tui.keys("C-b");
  tui.type("X");
  await tui.waitForScreen(screen(tui.warning, "aXb")); // the cursor moved; no hint
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), []);

  tui.keys("C-e", "C-u");
  tui.freeCtrlB();
  // No second warning, and the command registered before the reload can now be backgrounded.
  await tui.waitForScreen(screen(["", RELOADED, ""], "", [HINT]));
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
  await tui.waitForScreen(screen(["", RELOADED, ""]));
});

test("Ctrl+B calls every registered handler, and the hint shows only while one is registered", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" }, { fg: "b" }, { fg: "c" }, { fgEnd: "c" });
  await tui.waitForScreen(screen([""], "", [" ● main", "   shell build · 0s", HINT]));

  tui.keys("C-b");
  await tui.waitForEvent("bg:b");
  await tui.waitForScreen(screen([""], "", [" ● main", "   shell build · 0s"]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), ["bg:a", "bg:b"]);

  // With nothing to background, Ctrl+B reaches the editor, which no longer binds it.
  tui.type("ab");
  tui.keys("C-b");
  tui.type("X");
  await tui.waitForScreen(screen([""], "abX", [" ● main", "   shell build · 0s"]));
});
