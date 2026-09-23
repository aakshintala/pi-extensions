// Tool grouping (#56) in a real pi: a run of calls is one live summary line, failed
// calls show under it, text between calls splits groups, Ctrl+O expands every call,
// Esc counts result-less calls as cancelled, and a click toggles one group.
// Pi draws all of a message's text before its tool calls, so text between two runs
// shows above both groups, not between them.
// Running screens wait for the group spinner's first frame (⠋): it comes round every
// 800 ms, and the wait fixture makes Pi's own working indicator still.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSIONS = ["../extensions/tool-display/index.ts", "./fixtures/tool-display/wait.ts"].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);
const WORKSPACE = fileURLToPath(new URL("./fixtures/tool-display/workspace", import.meta.url));
const TOOLS = ["--tools", "read,edit,write,wait"];
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const text = (t) => ({ type: "text", text: t });
const RULE = "─".repeat(80);

// A full 30-row screen: `top` rows, blank rows, then `bottom` rows.
const rows = (top, bottom = []) => "\n" + [...top, ...Array(30 - top.length - bottom.length).fill(""), ...bottom].join("\n");

async function start(t, replies, args = []) {
  const tui = await startTui(t, { extensions: EXTENSIONS, args: [...TOOLS, ...args], rows: 30, replies });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  cpSync(WORKSPACE, tui.cwd, { recursive: true });
  tui.type("go");
  tui.keys("Enter");
  return tui;
}

test("a run of calls is one live summary line; failures show under it; text makes a second group, drawn after all of the message's text; Ctrl+O expands", async (t) => {
  const tui = await start(t, [
    [
      text("Looking."),
      call("c1", "read", { path: "a.txt" }),
      call("c2", "edit", { path: "b.txt", edits: [{ oldText: "two\nthree", newText: "2\n3\n3.5" }] }),
      call("c3", "wait", { file: "go" }),
      call("c4", "edit", { path: "a.txt", edits: [{ oldText: "delta", newText: "DELTA" }] }),
      text("Then:"),
      call("c5", "write", { path: "c.txt", content: "l1\nl2\n" }),
    ],
    "Done.",
  ]);
  const top = (bullet) => `

 go


 Looking.
 Then:

 ${bullet} Read 1 file, edited 2 files +3 −2, waited on 1 file · 1 failed

 ⏺ Edit(a.txt)
   ⎿  Error: Could not find the exact text in a.txt. The old text must match
      exactly including all whitespace and newlines.

 ⏺ Wrote 1 file +2
`;
  await tui.waitForScreen(`${top("⠋")}
── ~ Working ───────────────────────────────────────────────────────────────────

${RULE}
~/cwd
↑2 ↓62 W2 CH0.0% 0.1%/128k (auto)                                      harness-1









`);

  writeFileSync(join(tui.cwd, "go"), "");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(`${top("⏺")}
 Done.

${RULE}

${RULE}
~/cwd
↑141 ↓64 R2 W141 CH0.7% 0.2%/128k (auto)                               harness-1







`);

  tui.keys("C-o");
  await tui.waitForScreen(`

 ⏺ Edit(b.txt)
   ⎿  Added 3 lines, removed 2 lines
      -two
      -three
      +2
      +3
      +3.5

 ⏺ Wait(go)
   ⎿  Released

 ⏺ Edit(a.txt)
   ⎿  Error: Could not find the exact text in a.txt. The old text must match
      exactly including all whitespace and newlines.

 ⏺ Write(c.txt)
   ⎿  Wrote 2 lines
      l1
      l2

 Done.

 Tool output: expanded

${RULE}

${RULE}
~/cwd
↑141 ↓64 R2 W141 CH0.7% 0.2%/128k (auto)                               harness-1`);
});

test("Esc counts calls with no result as cancelled", async (t) => {
  const tui = await start(t, [[call("c1", "read", { path: "a.txt" }), call("c2", "wait", { file: "x" }), call("c3", "wait", { file: "y" })], "Done."]);
  await tui.waitForEvent("tool_execution_end"); // the read is done, both waits are running
  await tui.waitForScreen(rows(["", " go", "", "", " ⠋ Read 1 file, waited on 2 files", "", `── ~ Working ${"─".repeat(67)}`, "", RULE, "~/cwd",
    "↑2 ↓15 W2 CH0.0% 0.0%/128k (auto)                                      harness-1"]));
  tui.keys("Escape");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows(["", " go", "", "", " ⏺ Read 1 file, waited on 2 files · 2 cancelled", "", " Error: This operation was aborted", "", RULE, "", RULE, "~/cwd",
    "↑2 ↓15 W2 0.0%/128k (auto)                                             harness-1"]));
});

test("in fullscreen, a click on a group toggles that group only", async (t) => {
  const read = (id, path) => call(id, "read", { path });
  const tui = await start(t, [[read("c1", "a.txt"), read("c2", "b.txt"), text("and"), read("c3", "b.txt")], "Done."], ["--tui-mode", "fullscreen"]);
  await tui.waitForEvent("agent_end");
  const screen = (...groups) => rows(["", " go", "", "", " and", "", ...groups, "", " Done."],
    ["", RULE, "", RULE, "~/cwd", "↑50 ↓20 R2 W50 CH2.0% 0.1%/128k (auto)                                 harness-1"]);
  const collapsed = screen(" ⏺ Read 2 files", "", " ⏺ Read 1 file");
  await tui.waitForScreen(collapsed);
  const row = (line) => tui.screen().split("\n").indexOf(line) + 1;

  tui.click(4, row(" ⏺ Read 2 files"));
  await tui.waitForScreen(screen(" ⏺ Read(a.txt)", "   ⎿  Read 3 lines", "", " ⏺ Read(b.txt)", "   ⎿  Read 4 lines", "", " ⏺ Read 1 file"));

  tui.click(8, row("   ⎿  Read 4 lines"));
  await tui.waitForScreen(collapsed);
});
