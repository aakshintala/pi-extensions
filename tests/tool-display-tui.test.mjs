// Tool display (#55) in a real pi: the built-in read, edit and write calls are
// grouped into one summary with failures folded, and Ctrl+O shows
// each call in the shared style with the edit diff taken from the call's arguments.
// After /new the new session is decorated exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSION = fileURLToPath(new URL("../extensions/tool-display/index.ts", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("./fixtures/tool-display/workspace", import.meta.url));
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

// The faux model replays these in every session, so after /new the same calls run
// again; the b.txt edit then fails because the first session already applied it.
const REPLIES = [
  [
    call("c1", "read", { path: "a.txt" }),
    call("c2", "edit", { path: "b.txt", edits: [{ oldText: "two\nthree", newText: "2\n3\n3.5" }] }),
    call("c3", "write", { path: "c.txt", content: "l1\nl2\nl3\nl4\nl5\nl6\n" }),
    call("c5", "edit", { path: "a.txt", edits: [{ oldText: "delta", newText: "DELTA" }] }),
  ],
  "Done.",
];

// Collapsed, failures stay folded without a failure alert.
// Expanded (Ctrl+O), each failed call draws its own error rows.
const A_FAILED = ` ⏺ Edit(a.txt)
   ⎿  Error: Could not find the exact text in a.txt. The old text must match
      exactly including all whitespace and newlines.`;
const A_FAILS = `\n${A_FAILED}`;
const calls = (prompt, summary, failures) => `

 ${prompt}


 ⏺ ${summary}${failures}

 Done.
`;
// Pads a screen to the pane's 40 rows.
const fill = (s) => s + "\n".repeat(41 - s.split("\n").length);
const RULE = "─".repeat(80);

test("tool display: decorated built-ins grouped, errors folded, Ctrl+O shows each call and the edit diff from arguments", async (t) => {
  const tui = await startTui(t, { extensions: [EXTENSION], args: ["--tools", "read,edit,write"], rows: 40, replies: REPLIES });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  cpSync(WORKSPACE, tui.cwd, { recursive: true });

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(fill(`${calls("go", "Read 1 file, edited 2 files +3 −2, wrote 1 file +6", "")}
${RULE}

${RULE}
~/cwd
↑130 ↓60 R2 W130 CH0.8% 0.2%/128k (auto)                               harness-1`));

  tui.keys("C-o");
  await tui.waitForScreen(fill(`

 go


 ⏺ Read(a.txt)
   ⎿  Read 3 lines
      alpha
      beta
      gamma

 ⏺ Edit(b.txt)
   ⎿  Added 3 lines, removed 2 lines
      -two
      -three
      +2
      +3
      +3.5

 ⏺ Write(c.txt)
   ⎿  Wrote 6 lines
      l1
      l2
      l3
      l4
      l5
      l6
${A_FAILS}

 Done.

 Tool output: expanded

${RULE}

${RULE}
~/cwd
↑130 ↓60 R2 W130 CH0.8% 0.2%/128k (auto)                               harness-1`));
  tui.keys("C-o");

  tui.type("/new");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", 2);
  tui.type("again");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end", 2);
  await tui.waitForScreen(fill(`${calls("again", "Read 1 file, edited 2 files, wrote 1 file +6", "")}

 ✓ New session started


${RULE}

${RULE}
~/cwd
↑148 ↓60 R3 W148 CH1.0% 0.2%/128k (auto)                               harness-1`));
});
