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
async function start(t, keybindings, args = []) {
  const tui = await startTui(t, { extensions: EXTENSIONS, cols: COLS, rows: ROWS, keybindings, args });
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
  // Writes keybindings.json and reloads; wait for the reloaded screen before typing.
  tui.reloadWith = (keybindings) => {
    writeFileSync(file, JSON.stringify(keybindings));
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
  tui.reloadWith({ "tui.editor.cursorLeft": ["left"] });
  // No second warning. The reload ended the session, which dropped its foreground command.
  await tui.waitForScreen(screen(["", RELOADED, ""]));
  await tui.fx({ fg: "b" });
  await tui.waitForScreen(screen(["", RELOADED, ""], "", [HINT]));
  tui.keys("C-b");
  await tui.waitForEvent("bg:b");
  await tui.waitForScreen(screen(["", RELOADED, ""]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), ["bg:b"]);
});

test("Ctrl+B blocked again by a reload warns once, at the next key", async (t) => {
  const tui = await start(t);
  tui.reloadWith({});
  await tui.waitForScreen(screen(["", RELOADED, ""])); // Pi re-reads keybindings.json after session_start
  tui.type("x");
  await tui.waitForScreen(screen(["", RELOADED, "", tui.warning[1], ""], "x"));
  tui.type("y");
  await tui.waitForScreen(screen(["", RELOADED, "", tui.warning[1], ""], "xy"));
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

test("a handler that throws is dropped: the hint goes and the next Ctrl+B reaches the editor", async (t) => {
  const tui = await start(t);
  await tui.fx({ fg: "a", throws: true });
  await tui.waitForScreen(screen([""], "", [HINT]));
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
  await tui.waitForScreen(screen([""]));
  tui.type("ab");
  tui.keys("C-b");
  tui.type("X");
  await tui.waitForScreen(screen([""], "abX"));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), ["bg:a"]);
});

test("the hint counts toward FleetView's 6 lines", async (t) => {
  const tui = await start(t);
  await tui.fx(...["a", "b", "c", "d", "e", "f"].map((id) => ({ add: id, kind: "shell", label: id })), { fg: "x" });
  await tui.waitForScreen(screen([""], "", [" ● main", "   shell a · 0s", "   shell b · 0s", "   shell c · 0s", "   … 3 more", HINT]));
});

test("Ctrl+B is not taken from an overlay, and cancels a stop confirmation", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" });
  const overlay = (bottom) => "\n" + [" shell build · 0s · esc back · ctrl+q stop", ...Array(ROWS - 2).fill(""), bottom].join("\n");
  tui.keys("Down", "Down", "Enter"); // regular mode: the viewer is a full-size overlay
  await tui.waitForScreen(overlay("›"));
  tui.keys("C-b", "C-q"); // the overlay has focus: Ctrl+B is left to it
  await tui.waitForScreen(overlay(" Stop shell build? y stops it, any other key cancels."));
  tui.keys("C-b"); // any other key cancels
  await tui.waitForScreen(overlay("›"));
  tui.keys("Escape");
  await tui.waitForScreen(screen([""], "", [" ● main", "   shell build · 0s", HINT]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), []);
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
});

test("at a stop confirmation in the chat area, Ctrl+B cancels it and backgrounds nothing", async (t) => {
  const tui = await start(t, undefined, ["--tui-mode", "fullscreen"]);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" });
  // Fullscreen: the item takes the chat area, FleetView keeps focus on its row (#136), and Pi's editor keeps TUI focus.
  const viewing = (below) => {
    const lines = [" shell build · 0s · esc back · ctrl+q stop"];
    const bottom = [BORDER, "", BORDER, "   main", "›● shell build · 0s", ...below, ...FOOTER];
    return "\n" + [...lines, ...Array(ROWS - lines.length - bottom.length).fill(""), ...bottom].join("\n");
  };
  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(viewing([HINT]));
  tui.keys("C-q");
  await tui.waitForScreen(viewing([" Stop shell build? y stops it, any other key cancels.", HINT]));
  tui.keys("C-b");
  await tui.waitForScreen(viewing([HINT]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), []);
  tui.keys("C-b"); // with the confirmation gone, Ctrl+B backgrounds
  await tui.waitForEvent("bg:a");
  await tui.waitForScreen(viewing([]));
});
