// Tool groups span assistant messages (#133) in a real pi: a run of tool-only
// responses is one summary line with no blank rows, hidden thinking in any of them
// leads it with "thought ·", a failed call shows right under it and Ctrl+O opens every
// call in order. Text, shown thinking, a steer delivered at the turn's end, and
// ask_user each split it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const TOOL_DISPLAY = path("../extensions/tool-display/index.ts");
const WAIT = path("./fixtures/tool-display/wait.ts");
const ASK_USER = path("../extensions/ask-user/index.ts");
const WORKSPACE = path("./fixtures/tool-display/workspace");
const RULE = "─".repeat(80);
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const read = (id, p) => call(id, "read", { path: p });
const think = (t) => ({ type: "thinking", thinking: t });
const text = (t) => ({ type: "text", text: t });

const ROWS = 50;
// A full screen: `top` rows, then blank rows.
const rows = (...top) => "\n" + [...top, ...Array(ROWS - top.length).fill("")].join("\n");
const footer = (usage) => ["", RULE, "", RULE, "~/cwd", usage];

async function start(t, replies, { extensions = [TOOL_DISPLAY], tools = "read,edit,write", hide = false } = {}) {
  const tui = await startTui(t, { extensions, args: ["--tools", tools], rows: ROWS, replies });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  cpSync(WORKSPACE, tui.cwd, { recursive: true });
  if (hide) {
    tui.keys("C-t");
    await tui.waitForScreen(rows("", " Thinking blocks: hidden", ...footer("0.0%/128k (auto)                                                       harness-1")));
  }
  tui.type("go");
  tui.keys("Enter");
  return tui;
}

test("four tool-only responses are one summary line: thought, combined counts, the failure folded; Ctrl+O opens every call in order", async (t) => {
  const tui = await start(
    t,
    [
      [think("Look."), read("c1", "a.txt")],
      [call("c2", "edit", { path: "a.txt", edits: [{ oldText: "zzz", newText: "x" }] }), read("c3", "b.txt")],
      [think("Fix."), call("c4", "edit", { path: "b.txt", edits: [{ oldText: "two", newText: "2" }] })],
      [call("c5", "write", { path: "c.txt", content: "l1\n" })],
      "Done.",
    ],
    { hide: true },
  );
  await tui.waitForEvent("agent_end");
  const usage = "↑145 ↓58 R230 W147 CH71.2% 0.1%/128k (auto)                            harness-1";
  const top = ["", " Thinking blocks: hidden", "", "", " go", "", ""];
  await tui.waitForScreen(rows(
    ...top,
    " ⏺ thought · read 2 files, edited 2 files +1 −1, wrote 1 file +1",
    "",
    " Done.",
    ...footer(usage),
  ));

  tui.keys("C-o");
  await tui.waitForScreen(rows(
    ...top,
    " ⏺ Read(a.txt)", "   ⎿  Read 3 lines", "      alpha", "      beta", "      gamma", "",
    " ⏺ Edit(a.txt)",
    "   ⎿  Error: Could not find the exact text in a.txt. The old text must match",
    "      exactly including all whitespace and newlines.",
    "",
    " ⏺ Read(b.txt)", "   ⎿  Read 4 lines", "      one", "      two", "      three", "      four", "",
    " ⏺ Edit(b.txt)", "   ⎿  Added 1 line, removed 1 line", "      -two", "      +2", "",
    " ⏺ Write(c.txt)", "   ⎿  Wrote 1 line", "      l1", "",
    " Done.",
    "",
    " Tool output: expanded",
    ...footer(usage),
  ));
});

test("text in a response splits the run", async (t) => {
  const tui = await start(t, [[read("c1", "a.txt")], [text("Now b."), read("c2", "b.txt")], "Done."]);
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows("", " go", "", "", " ⏺ Read 1 file", "", " Now b.", "", " ⏺ Read 1 file", "", " Done.",
    ...footer("↑38 ↓15 R21 W39 CH32.8% 0.0%/128k (auto)                               harness-1")));
});

test("a steer delivered at the end of a turn splits the run", async (t) => {
  const tui = await start(t, [[call("c1", "wait", { file: "go" })], [read("c2", "a.txt")], "Done."], { extensions: [TOOL_DISPLAY, WAIT], tools: "read,wait" });
  await tui.waitForEvent("message_end", 2); // the prompt, then the response calling wait
  tui.type("also this");
  tui.keys("Enter");
  // A running group shows the static ⏺ summary at once; the wait fixture keeps Pi's own indicator still.
  await tui.waitForScreen(rows("", " go", "", "", " ⏺ Waited on 1 file", "", " Steering: also this", ` ↳ ${process.platform === "darwin" ? "Option" : "Alt"}+Up to edit all queued messages`, "",
    `── ~ Working ${"─".repeat(67)}`, "", RULE, "~/cwd", "↑2 ↓5 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"));
  writeFileSync(join(tui.cwd, "go"), "");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows("", " go", "", "", " ⏺ Waited on 1 file", "", "", " also this", "", "", " ⏺ Read 1 file", "", " Done.",
    ...footer("↑37 ↓13 R22 W37 CH37.0% 0.0%/128k (auto)                               harness-1")));
});

test("ask_user splits the run", async (t) => {
  const questions = [{ question: "Which?", header: "pick", options: [{ label: "Alpha" }, { label: "Beta" }] }];
  const tui = await start(t, [[read("c1", "a.txt")], [call("c2", "ask_user", { questions })], [read("c3", "b.txt")], "Done."], {
    extensions: [TOOL_DISPLAY, ASK_USER],
    tools: "read,ask_user",
  });
  await tui.waitForEvent("message_end", 4);
  await tui.waitForScreen(rows("", " go", "", "", " ⏺ Read 1 file", "", " ⏺ Ask User(pick)", "", RULE, "Which?", "", "→ 1. Alpha", "  2. Beta",
    "  3. Type your own answer", "", "  ↑↓ move · Enter choose · Esc cancel", RULE, "~/cwd", "↑19 ↓34 R2 W19 CH5.6% 0.1%/128k (auto)                                 harness-1"));
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows("", " go", "", "", " ⏺ Read 1 file", "", " ⏺ Ask User(pick)", "   ⎿  pick: Alpha", "", " ⏺ Read 1 file", "", " Done.",
    ...footer("↑75 ↓42 R79 W76 CH62.4% 0.1%/128k (auto)                               harness-1")));
});

test("thinking shown with Ctrl+T splits the run, and hiding it again joins it", async (t) => {
  const tui = await start(t, [[read("c1", "a.txt")], [think("Next."), read("c2", "b.txt")], "Done."], { hide: true });
  await tui.waitForEvent("agent_end");
  const usage = "↑38 ↓15 R21 W38 CH33.3% 0.0%/128k (auto)                               harness-1";
  const top = ["", " Thinking blocks: hidden", "", "", " go", "", ""];
  await tui.waitForScreen(rows(...top, " ⏺ thought · read 2 files", "", " Done.", ...footer(usage)));
  tui.keys("C-t");
  await tui.waitForScreen(rows(...top, " ⏺ Read 1 file", "", " ✻ Thinking", " Next.", "", " ⏺ thought · read 1 file", "", " Done.", "",
    " Thinking blocks: visible", ...footer(usage)));
  tui.keys("C-t");
  await tui.waitForScreen(rows(...top, " ⏺ thought · read 2 files", "", " Done.", "", " Thinking blocks: hidden", ...footer(usage)));
});
