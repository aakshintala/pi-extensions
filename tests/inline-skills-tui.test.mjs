// tmux TUI tests for inline-skills (ADR 0001: event-synchronised, full-screen asserts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXT = new URL("../extensions/inline-skills/index.ts", import.meta.url).pathname;
const PLAIN_EDITOR = new URL("./fixtures/inline-skills/plain-editor.ts", import.meta.url).pathname;
const FOOTER = new URL("./fixtures/inline-skills/footer.ts", import.meta.url).pathname;
const SKILLS = new URL("./fixtures/inline-skills/skills", import.meta.url).pathname;
const RELOAD_GATE = new URL("./fixtures/inline-skills/reload-gate.ts", import.meta.url).pathname;
const SWAP_EDITOR = new URL("./fixtures/inline-skills/swap-editor.ts", import.meta.url).pathname;
const ASK_USER = new URL("../extensions/ask-user/index.ts", import.meta.url).pathname;

async function start(t, { extensions = [EXT], replies = [], args = [] } = {}) {
  const tui = await startTui(t, { extensions: [FOOTER, ...extensions], replies, args: ["--skill", SKILLS, ...args] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), [])); // runs after the helper's cleanup
  return tui;
}

// An 80x24 screen: `above` (the transcript), the editor holding `text`, then `below`.
const screen = (above, text, below = []) => {
  const rows = [...above, "─".repeat(80), text, "─".repeat(80), ...below, "(footer)"];
  return "\n" + [...rows, ...Array(24 - rows.length).fill("")].join("\n");
};
const idle = (text, below) => screen([""], text, below);
const GRI = [
  "→ grill-with-docs                 Grill a plan and record ADRs.",
  "  grilling                        Grill the user about a plan.",
  "  setup-grill                     Install the grill skills.",
];

test("mid-prompt / plus two letters opens the skill list; Tab and Enter accept", async (t) => {
  const tui = await start(t);
  tui.type("please run /g");
  await tui.waitForScreen(idle("please run /g"));
  tui.type("r");
  await tui.waitForScreen(idle("please run /gr", GRI));
  tui.keys("Tab");
  await tui.waitForScreen(idle("please run /grill-with-docs"));
  tui.type("then /set");
  await tui.waitForScreen(idle("please run /grill-with-docs then /set", ["→ setup-grill                     Install the grill skills."]));
  tui.keys("Enter");
  await tui.waitForScreen(idle("please run /grill-with-docs then /setup-grill"));
});

test("the patch works in fullscreen mode too", async (t) => {
  const tui = await start(t, { args: ["--tui-mode", "fullscreen"] });
  tui.type("please /gr");
  const rows = ["─".repeat(80), "please /gr", "─".repeat(80), ...GRI, "(footer)"];
  await tui.waitForScreen("\n" + [...Array(24 - rows.length).fill(""), ...rows].join("\n"));
});

test("Tab opens the list at any point; start-of-message / and paths stay Pi's", async (t) => {
  const tui = await start(t);
  tui.type("x /");
  tui.keys("Tab");
  await tui.waitForScreen(idle("x /", [
    "→ grill-with-docs                 Grill a plan and record ADRs.",
    "  grilling                        Grill the user about a plan.",
    "  markup                          A skill whose body holds markup.",
    "  setup-grill                     Install the grill skills.",
    "  tdd                             Test-driven development.",
  ]));
  tui.keys("Escape"); // alone: Escape followed at once by another key reads as Alt+key
  await tui.waitForScreen(idle("x /"));
  tui.keys("C-u");
  tui.type("try /m");
  tui.keys("Tab");
  await tui.waitForScreen(idle("try /markup"));
  tui.keys("C-u");
  tui.type("use (/g");
  tui.keys("Tab");
  await tui.waitForScreen(idle("use (/g", GRI));
  tui.keys("Escape");
  await tui.waitForScreen(idle("use (/g"));
  tui.keys("C-u");
  tui.type("try /zzq");
  tui.keys("Tab");
  await tui.waitForScreen(idle("try /zzq"));
  tui.keys("C-u");
  tui.type("see /usr/lo");
  tui.keys("Tab");
  await tui.waitForScreen(idle("see /usr/local/"));
  tui.keys("C-u");
  tui.type("/gr");
  await tui.waitForScreen(idle("/gr", [
    "→ skill:grill-with-docs  [t] Grill a plan and record ADRs.",
    "  skill:grilling         [t] Grill the user about a plan.",
    "  skill:setup-grill      [t] Install the grill skills.",
  ]));
});

test("submitted skills show once in the transcript", async (t) => {
  const tui = await start(t, { replies: ["ok", "ok"] });
  tui.type("use /tdd and /markup now");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  tui.type("again /tdd now");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end", 2);
  await tui.waitForScreen(screen(
    ["", " use /tdd and /markup now", "", "", "", " [skill] tdd (ctrl+o to expand)", "", "",
      " [skill] markup (ctrl+o to expand)", "", "", " ok", "", "", " again /tdd now", "", "", " ok", ""],
    "",
  ));
});

test("on an editor shape mismatch the patch is skipped and Tab still completes", async (t) => {
  const tui = await start(t, { extensions: [PLAIN_EDITOR, EXT], replies: ["ok"] });
  tui.type("please /gr");
  await tui.waitForScreen(idle("please /gr"));
  tui.keys("Tab");
  await tui.waitForScreen(idle("please /gr", GRI));
  tui.keys("Tab");
  await tui.waitForScreen(idle("please /grill-with-docs"));
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(screen(
    ["", " please /grill-with-docs", "", "", "", " [skill] grill-with-docs (ctrl+o to expand)", "", "", " ok", ""],
    "",
  ));
});

test("enabled through /reload, the wrap is installed once the editor is back", async (t) => {
  const tui = await start(t, { extensions: [RELOAD_GATE] });
  writeFileSync(join(tui.cwd, "enable-inline-skills"), "");
  tui.type("/reload");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", 2);
  const notice = [" Reloaded keybindings, extensions, skills, prompts, themes, and context files", ""];
  await tui.waitForScreen(screen(["", ...notice], ""));
  tui.type("please /gr");
  await tui.waitForScreen(screen(["", ...notice], "please /gr", GRI));
});

test("an editor swapped in after start gets the wrap", async (t) => {
  const tui = await start(t, { extensions: [SWAP_EDITOR, EXT] });
  tui.type("/swap");
  tui.keys("Enter");
  await tui.waitForScreen(screen(["", " swapped", ""], ""));
  tui.type("please /gr");
  await tui.waitForScreen(screen(["", " swapped", ""], "please /gr", GRI));
});

test("the ask_user panel in the editor slot is left alone", async (t) => {
  const RULE = "─".repeat(80);
  const questions = [{ question: "Which db?", header: "db", options: [{ label: "Alpha" }, { label: "Beta" }] }];
  const call = [{ type: "toolCall", id: "c1", name: "ask_user", arguments: { questions } }];
  const tui = await start(t, { extensions: [ASK_USER, EXT], replies: [call, "done"] });
  tui.type("ask");
  tui.keys("Enter");
  const above = ["", " ask", "", "", " ⏺ Ask User(db)", "", RULE];
  const panel = (body) =>
    "\n" +
    [...above, "Which db?", "", ...body, "", "  ↑↓ move · Enter choose · Esc cancel", RULE, "(footer)", ...Array(24 - (above.length + 2 + body.length + 4)).fill("")].join(
      "\n",
    );
  await tui.waitForScreen(panel(["→ 1. Alpha", "  2. Beta", "  3. Type your own answer"]));
  tui.keys("Up");
  tui.type("x /ab");
  await tui.waitForScreen(panel(["  1. Alpha", "  2. Beta", "→ 3. x /ab"]));
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const done = ["", " ask", "", "", " ⏺ Ask User(db)", '   ⎿  db: "x /ab"', "", " done", ""];
  await tui.waitForScreen(screen(done, ""));
  tui.type("please /gr");
  await tui.waitForScreen(screen(done, "please /gr", GRI));
});
