// Ctrl+B (#47) in a real pi. Its hint is on the running call (#139), never under the editor. The test producer registers "background now"
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
const RELOADED = " Reloaded keybindings, extensions, skills, prompts, themes, and context files";

/** Waits for a fragment to appear on the screen, where an exact screen would be brittle. */
async function waitForText(tui, text) {
  for (let i = 0; i < 100 && !tui.screen().includes(text); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(tui.screen().includes(text), `expected ${text} in screen:\n${tui.screen()}`);
}

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
  await tui.waitForScreen(screen(["", RELOADED, ""])); // no hint row under the editor
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

test("Ctrl+B calls every registered handler, and reaches the editor once none is registered", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" }, { fg: "b" }, { fg: "c" }, { fgEnd: "c" });
  await tui.waitForScreen(screen([""], "", [" ● main", "   1 shell running in background"]));

  tui.keys("C-b");
  await tui.waitForEvent("bg:b");
  await tui.waitForScreen(screen([""], "", [" ● main", "   1 shell running in background"]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), ["bg:a", "bg:b"]);

  // With nothing to background, Ctrl+B reaches the editor, which no longer binds it.
  tui.type("ab");
  tui.keys("C-b");
  tui.type("X");
  await tui.waitForScreen(screen([""], "abX", [" ● main", "   1 shell running in background"]));
});

test("a handler that throws is dropped: the next Ctrl+B reaches the editor", async (t) => {
  const tui = await start(t);
  await tui.fx({ fg: "a", throws: true });
  await tui.waitForScreen(screen([""]));
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
  await tui.waitForScreen(screen([""]));
  tui.type("ab");
  tui.keys("C-b");
  tui.type("X");
  await tui.waitForScreen(screen([""], "abX"));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), ["bg:a"]);
});

test("FleetView keeps all 6 lines for rows while a command can be backgrounded", async (t) => {
  const tui = await start(t);
  await tui.fx(...["a", "b", "c", "d", "e", "f"].map((id) => ({ add: id, kind: "agent", label: id })), { fg: "x" }); // agents keep one row each, so the 6-line window shows
  await tui.waitForScreen(screen([""], "", [" ● main", "   agent a · 0s", "   agent b · 0s", "   agent c · 0s", "   agent d · 0s", "   … 2 more"]));
});

test("Ctrl+B is not taken from an overlay", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" });
  const overlay = (bottom) => "\n" + [" shell build · 0s · esc back", ...Array(ROWS - 2).fill(""), bottom].join("\n");
  tui.keys("Down", "Down", "Enter"); // the shared shells row: a picker over the running shells opens
  await waitForText(tui, "Running shells");
  assert.match(tui.screen(), /build · j/, "the picker lists the only running shell");
  tui.keys("Enter"); // the only running shell: exit into its log viewer
  await tui.waitForScreen(overlay("›"));
  tui.keys("C-b"); // the overlay has focus: Ctrl+B is left to it
  tui.type("hi");
  await tui.waitForScreen(overlay("› hi"));
  tui.keys("Escape");
  await tui.waitForScreen(screen([""], "", [" ● main", "   1 shell running in background"]));
  assert.deepEqual(tui.events().filter((e) => e.startsWith("bg:")), []);
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
});

test("Ctrl+B backgrounds while FleetView has focus on an item shown in the chat area", async (t) => {
  const tui = await start(t, undefined, ["--tui-mode", "fullscreen"]);
  await tui.fx({ add: "j", kind: "shell", label: "build" }, { fg: "a" });
  // Fullscreen: the item takes the chat area, FleetView keeps focus on its row (#136), and Pi's editor keeps TUI focus.
  const viewing = (below) => {
    const lines = [" shell build · 0s · esc back"];
    const bottom = [BORDER, "", BORDER, "   main", "›● 1 shell running in background", " Enter to view · x to stop · ctrl+x ctrl+k to stop all agents", ...below, ...FOOTER];
    return "\n" + [...lines, ...Array(ROWS - lines.length - bottom.length).fill(""), ...bottom].join("\n");
  };
  tui.keys("Down", "Down", "Enter"); // the shared shells row: pick the job from the picker
  await waitForText(tui, "Running shells");
  assert.match(tui.screen(), /build · j/, "the picker lists the only running shell");
  tui.keys("Enter");
  await tui.waitForScreen(viewing([]));
  tui.keys("C-b");
  await tui.waitForEvent("bg:a");
  await tui.waitForScreen(viewing([]));
});
