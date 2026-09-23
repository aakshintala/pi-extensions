// Subagents (#52) in a real pi: the agent's FleetView row with its live activity, then
// its completion notice. Children load their extensions from the sealed agent dir's
// settings.json and answer from kid.json (tests/fixtures/subagents/kid.ts).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const EXTENSIONS = [path("./fixtures/subagents/kid.ts"), path("../extensions/fleet/index.ts"), path("../extensions/subagents/index.ts")];

test("an agent's row shows its live activity, then its completion notice", async (t) => {
  const spawn = { type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { description: "scout", prompt: "find the notes", model: "kid/kid-1", thinking: "low" } };
  const tui = await startTui(t, { extensions: EXTENSIONS, replies: [[spawn], "spawned", "read it"] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const agentDir = join(dirname(tui.home), "agent");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, extensions: EXTENSIONS }));
  writeFileSync(join(agentDir, "kid.json"), JSON.stringify([
    { content: [{ type: "toolCall", id: "k1", name: "read", arguments: { path: "notes.md" } }] },
    { content: "found 3 notes\nSTATUS: DONE", after: "go" },
  ]));

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("child_start");
  const id = readFileSync(join(agentDir, "child-id"), "utf8");
  const started = `   ⎿  Subagent ${id} started.`;
  await tui.waitForScreen(screen([
    " go", "", "", " ⏺ Agent(scout)", started, "", " spawned", "",
  ], "   agent scout · 0s · read notes.md", "↑44 ↓28 R2 W44 CH2.3% 0.1%/128k (auto)                       (harness) harness-1"));

  writeFileSync(join(agentDir, "go"), ""); // the child's next reply
  await tui.waitForScreen(screen([
    " go", "", "", " ⏺ Agent(scout)", started, "", " spawned", "",
    " ✓ agent scout · done 0s · STATUS: DONE", "", " read it", "",
  ], "   agent scout · done 0s · STATUS: DONE", "↑82 ↓30 R46 W83 CH36.4% 0.1%/128k (auto)                     (harness) harness-1"));
});

const ROWS = 24;
const BORDER = "─".repeat(80);
// Regular mode: a blank row, the chat, the editor, FleetView (main and `row`), the footer.
function screen(chat, row, footer) {
  const lines = ["", ...chat, BORDER, "", BORDER, " ● main", row, "~/cwd", footer];
  return "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");
}
