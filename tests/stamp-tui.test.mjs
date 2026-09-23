// Stamps in a real pi (spec #36, ADR 0001): fixed clock in UTC, full-screen asserts.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
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
  const tui = await start(t, [[{ type: "toolCall", id: "c1", name: "ls", arguments: {} }], "Done."], 48);
  tui.type("run it");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  // The unknown tool fails at once, so its stamp is deterministic: 0.0s, error.
  const transcript = (on) => `

 run it


${STAMP}


 ls .

 Tool ls not found


${STAMP}${on ? `\n${" ".repeat(58)}tool ls · 0.0s · error` : ""}

 Done.

${STAMP}
`;
  const FOOTER = `~/cwd
↑16 ↓4 R3 W16 CH10.3% 0.0%/128k (auto)                                 harness-1`;
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
