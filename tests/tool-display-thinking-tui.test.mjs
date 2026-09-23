// Hidden thinking (#57) in a real pi: with thinking hidden (Ctrl+T) a turn's thinking
// renders zero lines, in a message with a tool call and in one with text, and the
// group summary starts with "thought ·". Shown again, each block gets the restyled label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSION = fileURLToPath(new URL("../extensions/tool-display/index.ts", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("./fixtures/tool-display/workspace", import.meta.url));
const RULE = "─".repeat(80);
const FOOTER = ["", RULE, "", RULE, "~/cwd", "↑22 ↓14 R2 W23 CH4.7% 0.0%/128k (auto)                                 harness-1"];
// A full 24-row screen: `top` rows, then blank rows.
const rows = (...top) => "\n" + [...top, ...Array(24 - top.length).fill("")].join("\n");

test("hidden thinking renders nothing, with a call and with text; shown, it is labelled", async (t) => {
  const tui = await startTui(t, {
    extensions: [EXTENSION],
    args: ["--tools", "read"],
    replies: [
      [{ type: "thinking", thinking: "Let me look." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }],
      [{ type: "thinking", thinking: "Now answer." }, { type: "text", text: "Done." }],
    ],
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  cpSync(WORKSPACE, tui.cwd, { recursive: true });

  tui.keys("C-t");
  await tui.waitForScreen(rows("", " Thinking blocks: hidden", "", RULE, "", RULE, "~/cwd", "0.0%/128k (auto)                                                       harness-1"));
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows("", " Thinking blocks: hidden", "", "", " go", "", "", " ⏺ thought · read 1 file", "", " Done.", ...FOOTER));

  tui.keys("C-t");
  await tui.waitForScreen(rows("", " Thinking blocks: hidden", "", "", " go", "", "", " ✻ Thinking", " Let me look.", "", " ⏺ thought · read 1 file", "",
    " ✻ Thinking", " Now answer.", "", " Done.", "", " Thinking blocks: visible", ...FOOTER));
});
