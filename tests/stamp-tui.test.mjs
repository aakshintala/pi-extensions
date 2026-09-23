// Stamps in a real pi (spec #36, ADR 0001): fixed clock in UTC, full-screen asserts.
import { test } from "node:test";
import assert from "node:assert";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const extensions = [root("extensions/rig/index.ts"), root("tests/fixtures/stamp/index.ts")];
const rows = (text, n) => text + "\n".repeat(n);
// Pads a screen (leading newline dropped, as waitForScreen does) to `height` rows.
const fill = (text, height) => text + "\n".repeat(height - text.replace(/^\n/, "").split("\n").length);
const STAMP = `${" ".repeat(72)}14:05:09`;

async function start(t, replies, rows) {
  const tui = await startTui(t, { extensions, replies, rows });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  return tui;
}

test("user and assistant messages get a right-aligned stamp", async (t) => {
  const tui = await start(t, ["Hello there."]);
  tui.type("hi");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows(`

 hi


${STAMP}

 Hello there.

${STAMP}

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑2 ↓3 W2 CH0.0% 0.0%/128k (auto)                                       harness-1`, 9));
});

test("turning toolStamps on in /rig shows stamps for tools that already ran", async (t) => {
  // The response has text, so its stamp shows while toolStamps is off (#142).
  const tui = await start(t, [[{ type: "text", text: "Listing." }, { type: "toolCall", id: "c1", name: "ls", arguments: {} }], "Done."], 48);
  tui.type("run it");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  // The unknown tool fails at once, so its stamp is deterministic: 0.0s, error.
  const transcript = (on) => `

 run it


${STAMP}

 Listing.


 ls .

 Tool ls not found


${STAMP}${on ? `\n${" ".repeat(58)}tool ls · 0.0s · error` : ""}

 Done.

${STAMP}
`;
  const FOOTER = `~/cwd
↑18 ↓6 R3 W18 CH9.1% 0.0%/128k (auto)                                  harness-1`;
  const editor = (on) => fill(`${transcript(on)}
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
${FOOTER}`, 48);
  const menu = (on) => fill(`${transcript(on)}
 [stamp]

  dateContext                 day-change
  locale                      invariant
  timeZone                    local
  responseTiming              off
  assistantMetadata           off
  showExactTimeline           true
  showThinkingLevel           true
  showCompactAbnormalOutcome  true
  showCostSinceUser           false
→ toolStamps                  ${on}
  (12/12)

  Duration and outcome of each tool. Default: false.

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default
${FOOTER}`, 48);
  await tui.waitForScreen(editor(false));

  tui.type("/rig");
  tui.keys("Enter");
  await tui.waitForScreen(menu(false).replace("  dateContext", "→ hourCycle                   24h\n  showSeconds                 true\n  dateContext")
    .replace("  showCostSinceUser           false\n→ toolStamps                  false\n  (12/12)", "  (1/12)")
    .replace("Duration and outcome of each tool. Default: false.", "Clock format. Default: 24h."));
  tui.keys("Up");
  await tui.waitForScreen(menu(false));
  tui.keys("Enter");
  await tui.waitForEvent("stamp.toolStamps=true");
  await tui.waitForScreen(menu(true));
  tui.keys("Escape");
  await tui.waitForScreen(editor(true));
});

test("/rig: a typed locale is validated, saved, and stays in the Enter cycle", async (t) => {
  const tui = await start(t, []);
  const FOOTER = `~/cwd
0.0%/128k (auto)                                                       harness-1`;
  const list = (locale) => fill(`

 [stamp]

  hourCycle                   24h
  showSeconds                 true
  dateContext                 day-change
→ locale                      ${locale}
  timeZone                    local
  responseTiming              off
  assistantMetadata           off
  showExactTimeline           true
  showThinkingLevel           true
  showCompactAbnormalOutcome  true
  (4/12)

  Time format locale. Default: invariant.

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default · e to type a value
${FOOTER}`, 24);
  const editor = (input, error) => fill(`

 [stamp]

locale
Time format locale. Default: invariant.

>${input ? ` ${input}` : ""}
${error ? "locale must be one of invariant, system or a BCP 47 tag\n" : ""}
  Enter to save · Esc to go back
${FOOTER}`, 24);

  tui.type("/rig");
  tui.keys("Enter");
  await tui.waitForScreen(
    list("invariant")
      .replace("  hourCycle", "→ hourCycle")
      .replace("→ locale", "  locale")
      .replace("(4/12)", "(1/12)")
      .replace("Time format locale. Default: invariant.", "Clock format. Default: 24h.")
      .replace(" · e to type a value", ""),
  );
  tui.keys("Down", "Down", "Down");
  await tui.waitForScreen(list("invariant"));
  tui.keys("e");
  await tui.waitForScreen(editor(""));
  tui.type("en_US");
  tui.keys("Enter");
  await tui.waitForScreen(editor("en_US", true));
  tui.keys("BSpace", "BSpace", "BSpace", "BSpace", "BSpace");
  tui.type("de-DE");
  tui.keys("Enter");
  await tui.waitForEvent("stamp.locale=de-DE");
  await tui.waitForScreen(list("de-DE"));
  // Enter cycles the named values and comes back to the typed one.
  for (const [value, n] of [["invariant", 1], ["system", 1], ["de-DE", 2]]) {
    tui.keys("Enter");
    await tui.waitForEvent(`stamp.locale=${value}`, n);
    await tui.waitForScreen(list(value));
  }
  const rigJson = JSON.parse(readFileSync(join(dirname(tui.home), "agent", "rig.json"), "utf8"));
  assert.deepEqual(rigJson, { stamp: { locale: "de-DE" } });
});

// #142: a tool-only response draws nothing, so its stamp draws nothing unless toolStamps
// is on. Pi's reload rebuilds the chat from the saved entries, as a resume does.
const read = (id, p) => ({ type: "toolCall", id, name: "read", arguments: { path: p } });
const RUN_ROWS = 30;
const run = (...top) => "\n" + [...top, ...Array(RUN_ROWS - top.length).fill("")].join("\n");
const RELOADED = " Reloaded keybindings, extensions, skills, prompts, themes, and context files";

async function startRun(t, replies) {
  const tui = await startTui(t, {
    extensions: [...extensions, root("extensions/tool-display/index.ts")],
    args: ["--tools", "read"],
    rows: RUN_ROWS,
    replies,
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  cpSync(root("tests/fixtures/tool-display/workspace"), tui.cwd, { recursive: true });
  return tui;
}

// Syncs on a screen that a later full-screen assert pins down.
async function waitForText(tui, text, present = true) {
  const deadline = Date.now() + 20_000;
  while (tui.screen().includes(text) !== present) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${present ? "" : "no "}${JSON.stringify(text)}\n${tui.screen()}`);
    await new Promise((r) => setTimeout(r, 10)); // poll interval, not a sync point
  }
}

async function setToolStamps(tui, n = 1) {
  tui.type("/rig");
  tui.keys("Enter");
  await waitForText(tui, "(1/12)");
  tui.keys("Up");
  await waitForText(tui, "(12/12)");
  tui.keys("Enter");
  await tui.waitForEvent("stamp.toolStamps=true", n);
  tui.keys("Escape");
  await waitForText(tui, "[stamp]", false);
}

async function reload(tui, n) {
  tui.type("/reload");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", n);
}

const footer = (usage) => ["", "─".repeat(80), "", "─".repeat(80), "~/cwd", usage];

test("four tool-only responses draw no stamp rows: the summary, the reply, one stamp; the same after a reload", async (t) => {
  const tui = await startRun(t, [[read("c1", "a.txt")], [read("c2", "b.txt")], [read("c3", "a.txt")], [read("c4", "b.txt")], "Done."]);
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const transcript = ["", " go", "", "", STAMP, "", " ⏺ Read 4 files", "", " Done.", "", STAMP];
  const usage = "↑71 ↓26 R112 W72 CH60.7% 0.1%/128k (auto)                              harness-1";
  await tui.waitForScreen(run(...transcript, ...footer(usage)));
  await reload(tui, 2);
  await tui.waitForScreen(run(...transcript, "", RELOADED, ...footer(usage)));
});

test("with toolStamps on, every response keeps its row, live and after a reload; turning it on brings hidden rows back", async (t) => {
  const tui = await startRun(t, [[read("c1", "a.txt")], [read("c2", "b.txt")], "Done."]);
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const tool = `${" ".repeat(54)}tool read · 0.0s · success`;
  const usage = "↑37 ↓14 R21 W37 CH34.5% 0.0%/128k (auto)                               harness-1";
  const off = ["", " go", "", "", STAMP, "", " ⏺ Read 2 files", "", " Done.", "", STAMP];
  await tui.waitForScreen(run(...off, ...footer(usage)));
  await setToolStamps(tui);
  await reload(tui, 2);
  const on = ["", " go", "", "", STAMP, "", " ⏺ Read 2 files", "", STAMP, tool, "", STAMP, tool, "", " Done.", "", STAMP];
  await tui.waitForScreen(run(...on, "", RELOADED, ...footer(usage)));
});

test("with toolStamps on from the start, the live rows match the reloaded ones", async (t) => {
  const tui = await startRun(t, [[read("c1", "a.txt")], [read("c2", "b.txt")], "Done."]);
  await setToolStamps(tui);
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const tool = `${" ".repeat(54)}tool read · 0.0s · success`;
  const usage = "↑37 ↓14 R21 W37 CH34.5% 0.0%/128k (auto)                               harness-1";
  const on = ["", " go", "", "", STAMP, "", " ⏺ Read 2 files", "", STAMP, tool, "", STAMP, tool, "", " Done.", "", STAMP];
  await tui.waitForScreen(run(...on, ...footer(usage)));
  await reload(tui, 2);
  await tui.waitForScreen(run(...on, "", RELOADED, ...footer(usage)));
});
