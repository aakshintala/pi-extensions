// Subagents (#52, #53) in a real pi: the agent's FleetView row with its live activity, then
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
  await tui.waitForEvent("agent_end", 2); // the parent's turn on the child's notice
  await tui.waitForScreen(screen([
    " go", "", "", " ⏺ Agent(scout)", started, "", " spawned", "",
    " ✓ agent scout · done 0s · STATUS: DONE", "", " read it", "",
  ], "   agent scout · done 0s · STATUS: DONE", "↑82 ↓30 R46 W82 CH36.7% 0.1%/128k (auto)                     (harness) harness-1"));
});

test("a nested agent's row is indented under its parent", async (t) => {
  const spawn = { type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { description: "scout", prompt: "find the notes", model: "kid/kid-1", thinking: "low" } };
  const tui = await startTui(t, { extensions: EXTENSIONS, replies: [[spawn], "spawned", "read it"] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const agentDir = join(dirname(tui.home), "agent");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, extensions: EXTENSIONS }));
  const nested = { type: "toolCall", id: "k1", name: "subagent_spawn", arguments: { description: "dig", prompt: "dig deeper", model: "kid/kid-1", thinking: "low" } };
  // Each agent holds its next reply until the file "go" exists, so the rows stay put. Then
  // scout waits for dig however the notice lands (a steer, or a wake after the listing).
  const text = (content, after) => ({ content, after });
  writeFileSync(join(agentDir, "kid.json"), JSON.stringify({
    "find the notes": [{ content: [nested] }, text("waiting", "go"), text("still waiting"), text("done\nSTATUS: DONE"), text("done\nSTATUS: DONE")],
    "dig deeper": [{ content: [{ type: "toolCall", id: "k2", name: "read", arguments: { path: "deep.md" } }] }, text("dug\nSTATUS: DONE", "go")],
  }));

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("child_start", 2);
  const id = readFileSync(join(agentDir, "child-id"), "utf8");
  await tui.waitForScreen(screen([
    " go", "", "", " ⏺ Agent(scout)", `   ⎿  Subagent ${id} started.`, "", " spawned", "",
  ], ["   agent scout · 0s · subagent_spawn dig", "     agent dig · 0s · read deep.md"], "↑44 ↓28 R2 W44 CH2.3% 0.1%/128k (auto)                       (harness) harness-1"));

  writeFileSync(join(agentDir, "go"), ""); // let both finish, so pi ends cleanly
  await tui.waitForEvent("agent_end", 2); // the parent's turn on scout's notice
});

const ROWS = 24;
const BORDER = "─".repeat(80);
// Regular mode: a blank row, the chat, the editor, FleetView (main and `row`, or rows), the footer.
function screen(chat, row, footer) {
  const lines = ["", ...chat, BORDER, "", BORDER, " ● main", ...[row].flat(), "~/cwd", footer];
  return "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");
}
