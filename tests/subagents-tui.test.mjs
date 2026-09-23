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
  const spawn = { type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { description: "scout", prompt: "find the notes", model: "kid/kid-1", thinking: "low", isolation: "none" } };
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
  ], "   agent scout · 0s · kid-1 · low · 1.0k tokens · read notes.md", "↑49 ↓32 R2 W49 CH2.1% 0.1%/128k (auto)                       (harness) harness-1"));

  writeFileSync(join(agentDir, "go"), ""); // the child's next reply
  await tui.waitForEvent("agent_end", 2); // the parent's turn on the child's notice
  await tui.waitForScreen(screen([
    " go", "", "", " ⏺ Agent(scout)", started, "", " spawned", "",
    " ✓ agent scout · done 0s · STATUS: DONE", "", " read it", "",
  ], "   agent scout · done 0s · kid-1 · low · 2.0k tokens · 2 turns · 1 tool use", "↑87 ↓34 R51 W87 CH39.2% 0.1%/128k (auto)                     (harness) harness-1"));
});

test("a nested agent's row is indented under its parent", async (t) => {
  const spawn = { type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { description: "scout", prompt: "find the notes", model: "kid/kid-1", thinking: "low", isolation: "none" } };
  const tui = await startTui(t, { extensions: EXTENSIONS, replies: [[spawn], "spawned", "read it"] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const agentDir = join(dirname(tui.home), "agent");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, extensions: EXTENSIONS }));
  const nested = { type: "toolCall", id: "k1", name: "subagent_spawn", arguments: { description: "dig", prompt: "dig deeper", model: "kid/kid-1", thinking: "low", isolation: "none" } };
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
  ], ["   agent scout · 0s · kid-1 · low · 1.0k tokens · subagent_spawn dig", "     agent dig · 0s · kid-1 · low · 1.0k tokens · read deep.md"], "↑49 ↓32 R2 W49 CH2.1% 0.1%/128k (auto)                       (harness) harness-1"));

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

// The transcript viewer (#68) in fullscreen mode, where it takes the chat area. Parent and
// children load the tool-display extension, so calls group and thinking hides as in the main chat.
const WITH_DISPLAY = [...EXTENSIONS, path("../extensions/tool-display/index.ts")];
const SPAWN = { type: "toolCall", id: "c1", name: "subagent_spawn", arguments: { description: "scout", prompt: "find the notes", model: "kid/kid-1", thinking: "low", isolation: "none" } };
const TASK = [" find the notes", "", " End your final message with one line: STATUS: DONE, STATUS:", " DONE_WITH_CONCERNS, STATUS: BLOCKED, STATUS: NEEDS_CONTEXT."];

/** The last rows of the viewer's content above the fullscreen dock: the editor, FleetView (main and `rows`) and the footer. */
function viewing(content, rows, footer) {
  const dock = [BORDER, "", BORDER, "   main", ...[rows].flat(), "~/cwd", footer];
  const chat = content.slice(-(ROWS - dock.length));
  return "\n" + [...chat, ...Array(ROWS - dock.length - chat.length).fill(""), ...dock].join("\n");
}

async function transcriptTui(t, replies, kid) {
  const tui = await startTui(t, { extensions: WITH_DISPLAY, args: ["--tui-mode", "fullscreen"], replies });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  tui.agentDir = join(dirname(tui.home), "agent");
  writeFileSync(join(tui.cwd, "notes.md"), "one\ntwo\n");
  writeFileSync(join(tui.cwd, "todo.md"), "three\n");
  writeFileSync(join(tui.agentDir, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: true, extensions: WITH_DISPLAY }));
  writeFileSync(join(tui.agentDir, "kid.json"), JSON.stringify(kid));
  tui.type("go");
  tui.keys("Enter");
  return tui;
}

test("the viewer shows a running agent's transcript, follows it and its steer, and stays open when it finishes", async (t) => {
  const tui = await transcriptTui(t, [[SPAWN], "spawned", "read it"], [
    {
      content: [
        { type: "thinking", thinking: "Where are they?" },
        { type: "toolCall", id: "k1", name: "read", arguments: { path: "notes.md" } },
        { type: "toolCall", id: "k2", name: "read", arguments: { path: "todo.md" } },
        { type: "toolCall", id: "k3", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
    { content: "found 3 notes\nSTATUS: DONE", after: "go" },
    { content: "none deeper\nSTATUS: DONE", after: "go2" },
  ]);
  await tui.waitForEvent("kid_reply", 2); // the child waits for its second reply
  await tui.waitForEvent("agent_end"); // the parent's turn
  tui.keys("Down", "Down", "Enter");
  // Pi's own components: the task as a user message, the hidden thinking and both reads as
  // one group line, and bash drawn natively from its definition.
  const calls = ["", "", " ⏺ thought · read 2 files", "", "", " $ echo hi", "", " hi", ""];
  const head = (state, keys = " · enter steers") => ` agent scout · ${state} · esc back · ctrl+q stop${keys}`;
  const footer = "↑49 ↓32 R2 W49 CH2.1% 0.1%/128k (auto)                       (harness) harness-1";
  await tui.waitForScreen(viewing([head("0s"), "", ...TASK, ...calls], "›● agent scout · 0s · kid-1 · low · 1.0k tokens · bash echo hi", footer));

  tui.type("look deeper"); // typing leaves FleetView for the editor // a steer: pending until the child's next step, then a user message
  tui.keys("Enter");
  await tui.waitForScreen(viewing([head("0s"), "", ...TASK, ...calls, "", " Steering: look deeper", ""], " ● agent scout · 0s · kid-1 · low · 1.0k tokens · bash echo hi", footer));

  writeFileSync(join(tui.agentDir, "go"), "");
  await tui.waitForEvent("kid_reply", 3); // its reply came, then the steer, and it waits again
  const replied = [...TASK, ...calls, "", " found 3 notes", " STATUS: DONE", "", "", " look deeper"];
  await tui.waitForScreen(viewing([head("0s"), "", ...replied, "", ""], " ● agent scout · 0s · kid-1 · low · 2.0k tokens · STATUS: DONE", footer));

  writeFileSync(join(tui.agentDir, "go2"), "");
  await tui.waitForEvent("agent_end", 2); // the parent's turn on the child's notice
  const done = [head("done 0s"), "", ...replied, "", "", " none deeper", " STATUS: DONE", ""];
  await tui.waitForScreen(viewing(done, " ● agent scout · done 0s · kid-1 · low · 3.0k tokens · 3 turns · 3 tool uses", "↑86 ↓34 R51 W87 CH39.5% 0.1%/128k (auto)                     (harness) harness-1"));
});

test("a finished agent's transcript opens from its saved session, ctrl+o expands its groups, and each open reads thinking visibility", async (t) => {
  const tui = await transcriptTui(t, [[SPAWN], "spawned", "read it"], [
    {
      content: [
        { type: "thinking", thinking: "Where are they?" },
        { type: "toolCall", id: "k1", name: "read", arguments: { path: "notes.md" } },
        { type: "toolCall", id: "k2", name: "read", arguments: { path: "todo.md" } },
        { type: "toolCall", id: "k3", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
    { content: "found 3 notes\nSTATUS: DONE" },
  ]);
  await tui.waitForEvent("agent_end", 2); // the parent's turn on the child's notice
  tui.keys("Down", "Down", "Enter");
  const content = [" agent scout · done 0s · esc back · ctrl+q stop · enter steers", "", ...TASK, "", "", " ⏺ thought · read 2 files", "", "", " $ echo hi", "", " hi", "", "", " found 3 notes", " STATUS: DONE", ""];
  await tui.waitForScreen(viewing(content, "›● agent scout · done 0s · kid-1 · low · 2.0k tokens · 2 turns · 3 tool uses", "↑87 ↓34 R51 W88 CH38.9% 0.1%/128k (auto)                     (harness) harness-1"));
  tui.keys("C-o"); // Pi's expand key opens the group, as in the main chat; it leaves FleetView
  const reads = [" ⏺ Read(notes.md)", "   ⎿  Read 2 lines", "      one", "      two", "", " ⏺ Read(todo.md)", "   ⎿  Read 1 line", "      three"];
  const expanded = [...reads, "", "", " $ echo hi", "", " hi", "", "", " found 3 notes", " STATUS: DONE", ""];
  await tui.waitForScreen(viewing(expanded, " ● agent scout · done 0s · kid-1 · low · 2.0k tokens · 2 turns · 3 tool uses", "↑87 ↓34 R51 W88 CH38.9% 0.1%/128k (auto)                     (harness) harness-1"));
  // Thinking visibility is read on each open.
  tui.keys("C-o", "Escape");
  writeFileSync(join(tui.agentDir, "settings.json"), JSON.stringify({ quietStartup: true, hideThinkingBlock: false, extensions: WITH_DISPLAY }));
  tui.keys("Down", "Down", "Enter");
  const shown = [...TASK, "", "", " ✻ Thinking", " Where are they?", "", " ⏺ thought · read 2 files", "", "", " $ echo hi", "", " hi", "", "", " found 3 notes", " STATUS: DONE", ""];
  await tui.waitForScreen(viewing(shown, "›● agent scout · done 0s · kid-1 · low · 2.0k tokens · 2 turns · 3 tool uses", "↑87 ↓34 R51 W88 CH38.9% 0.1%/128k (auto)                     (harness) harness-1"));
});

test("a running call's output shows as it comes, and ctrl+q then y in the viewer stops the agent", async (t) => {
  // The call prints, then runs until the stop kills it.
  const command = "echo started; while :; do sleep 0.05; done";
  const tui = await transcriptTui(t, [[SPAWN], "spawned", "noted"], [
    { content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command } }] },
  ]);
  await tui.waitForEvent("agent_end");
  tui.keys("Down", "Down", "Enter");
  const head = (state) => ` agent scout · ${state} · esc back · ctrl+q stop · enter steers`;
  const running = ["", ...TASK, "", "", "", ` $ ${command}`, "", " started"];
  const row = `›● agent scout · 0s · kid-1 · low · 1.0k tokens · bash echo started; while :;...`;
  const footer = "↑49 ↓32 R2 W49 CH2.1% 0.1%/128k (auto)                       (harness) harness-1";
  await tui.waitForScreen(viewing([head("0s"), ...running, ""], row, footer));
  tui.keys("C-q");
  await tui.waitForScreen(viewing([head("0s"), ...running, ""], [row, " Stop agent scout? y stops it, any other key cancels."], footer));
  tui.keys("y");
  await tui.waitForEvent("agent_end", 2); // the parent's turn on the child's notice
  const stopped = [head("stopped 0s"), ...running, "", "", " Command aborted", "", "", " Error: This operation was aborted", ""];
  await tui.waitForScreen(viewing(stopped, "›● agent scout · stopped 0s · kid-1 · low · 1.0k tokens · 2 turns · 1 tool use", "↑83 ↓34 R51 W84 CH41.5% 0.1%/128k (auto)                     (harness) harness-1"));
});
