// /rig menu in a real pi (spec #32, ADR 0001): tabs, editing, refusal, reset.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const extensions = [root("extensions/rig/index.ts"), root("tests/fixtures/rig/index.ts")];
const FOOTER = `~/cwd
0.0%/128k (auto)                                                       harness-1`;
const rows = (text, n) => text + "\n".repeat(n);
// Fullscreen anchors the same rows to the bottom of the pane.
const bottom = (screen) => {
  const body = screen.replace(/\n+$/, "");
  return "\n".repeat(screen.length - body.length) + body;
};

async function openRig(t, args = []) {
  const fit = args.includes("fullscreen") ? bottom : (s) => s;
  const tui = await startTui(t, { extensions, args });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const file = () => {
    const path = join(dirname(tui.home), "agent", "rig.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  };
  tui.type("/rig");
  await tui.waitForScreen(fit(rows(`

────────────────────────────────────────────────────────────────────────────────
/rig
────────────────────────────────────────────────────────────────────────────────
→ rig         [t] Rig settings
${FOOTER}`, 17)));
  tui.keys("Enter");
  return { tui, file };
}

const alpha = ({ cursor = 0, enabled = "true", count = "10", mode = "fast", description = "Turn alpha on. Default: true." } = {}) => {
  const row = (i, label, value) => `${i === cursor ? "→ " : "  "}${label}${value}`;
  return rows(`

 [alpha]  beta

${row(0, "enabled  ", enabled)}
${row(1, "count    ", count)}
${row(2, "mode     ", mode)}

  ${description}

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default
${FOOTER}`, 11);
};

const editor = (tabs, key, description, input, error) => rows(`

 ${tabs}

${key}
${description}

>${input ? ` ${input}` : ""}
${error ? `${error}\n` : ""}
  Enter to save · Esc to go back
${FOOTER}`, error ? 12 : 13);
const countEditor = (input, error) => editor("[alpha]  beta", "count", "How many alphas. Default: 10.", input, error);

test("/rig opens a tab per section with settings and switches tabs with Left/Right", async (t) => {
  const { tui } = await openRig(t);
  // gamma declares no settings, so it has no tab.
  await tui.waitForScreen(alpha());
  tui.keys("Right");
  const beta = rows(`

  alpha  [beta]

→ limit  2
  tone   low

  Beta limit. Default: 2.

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default
${FOOTER}`, 12);
  await tui.waitForScreen(beta);
  tui.keys("Right");
  await tui.waitForScreen(alpha());
  tui.keys("Left");
  await tui.waitForScreen(beta);
  tui.keys("Left");
  await tui.waitForScreen(alpha());
});

test("/rig edits save to rig.json and reach the extension; invalid input is refused; r resets", async (t) => {
  const { tui, file } = await openRig(t);
  await tui.waitForScreen(alpha());

  tui.keys("Enter");
  await tui.waitForEvent("alpha.enabled=false");
  await tui.waitForScreen(alpha({ enabled: "false" }));
  assert.deepEqual(file(), { alpha: { enabled: false } });

  tui.keys("Down");
  await tui.waitForScreen(alpha({ cursor: 1, enabled: "false", description: "How many alphas. Default: 10." }));
  tui.keys("Enter");
  tui.type("99");
  tui.keys("Enter");
  await tui.waitForScreen(countEditor("99", "count must be between 1 and 32"));
  assert.deepEqual(file(), { alpha: { enabled: false } });

  // An edit clears the refusal; the next refused submit shows it again.
  tui.keys("BSpace");
  await tui.waitForScreen(countEditor("9", ""));
  tui.type("9");
  tui.keys("Enter");
  await tui.waitForScreen(countEditor("99", "count must be between 1 and 32"));

  tui.keys("BSpace", "BSpace");
  tui.type("5");
  tui.keys("Enter");
  await tui.waitForEvent("alpha.count=5");
  const edited = { cursor: 1, enabled: "false", count: "5", description: "How many alphas. Default: 10." };
  await tui.waitForScreen(alpha(edited));
  assert.deepEqual(file(), { alpha: { enabled: false, count: 5 } });

  tui.keys("r");
  await tui.waitForEvent("alpha.count=10");
  await tui.waitForScreen(alpha({ ...edited, count: "10" }));
  assert.deepEqual(file(), { alpha: { enabled: false } });

  tui.keys("Up");
  tui.keys("r");
  await tui.waitForEvent("alpha.enabled=true");
  await tui.waitForScreen(alpha());
  assert.deepEqual(file(), {});
});

test("/rig: r resets the row a mouse click selected", async (t) => {
  // Pi reads the mouse only in fullscreen.
  const { tui } = await openRig(t, ["--tui-mode", "fullscreen"]);
  await tui.waitForScreen(bottom(alpha()));
  // A click selects `mode` and cycles its value.
  tui.click(4, tui.screen().split("\n").indexOf("  mode     fast") + 1);
  await tui.waitForEvent("alpha.mode=slow");
  const mode = { cursor: 2, mode: "slow", description: "Alpha mode. Default: fast." };
  await tui.waitForScreen(bottom(alpha(mode)));
  tui.keys("r");
  await tui.waitForEvent("alpha.mode=fast");
  await tui.waitForScreen(bottom(alpha({ ...mode, mode: "fast" })));
});

test("/rig: an edit clears the open-enum editor's refusal", async (t) => {
  const { tui, file } = await openRig(t);
  await tui.waitForScreen(alpha());
  tui.keys("Right", "Down", "e");
  const tone = (input, error) => editor(" alpha  [beta]", "tone", "Beta tone. Default: low.", input, error);
  await tui.waitForScreen(tone("", ""));
  tui.type("x");
  tui.keys("Enter");
  const refused = "tone must be one of low, high or a number";
  await tui.waitForScreen(tone("x", refused));
  tui.keys("BSpace");
  await tui.waitForScreen(tone("", ""));
  tui.type("y");
  tui.keys("Enter");
  await tui.waitForScreen(tone("y", refused));
  tui.keys("BSpace");
  tui.type("7");
  tui.keys("Enter");
  await tui.waitForEvent("beta.tone=7");
  assert.deepEqual(file(), { beta: { tone: "7" } });
});

test("/rig: a click below the last row selects nothing, and r still resets the selected row", async (t) => {
  const { tui } = await openRig(t, ["--tui-mode", "fullscreen"]);
  await tui.waitForScreen(bottom(alpha()));
  const modeRow = tui.screen().split("\n").indexOf("  mode     fast") + 1;
  tui.click(4, modeRow);
  await tui.waitForEvent("alpha.mode=slow");
  const mode = { cursor: 2, mode: "slow", description: "Alpha mode. Default: fast." };
  await tui.waitForScreen(bottom(alpha(mode)));
  tui.click(4, modeRow + 1); // the blank row under the list
  tui.keys("r");
  await tui.waitForEvent("alpha.mode=fast");
  await tui.waitForScreen(bottom(alpha({ ...mode, mode: "fast" })));
  assert.deepEqual(tui.events(), ["session_start", "alpha.mode=slow", "alpha.mode=fast"]);
});

test("/rig: clicks do not reach the list behind an open editor", async (t) => {
  const { tui, file } = await openRig(t, ["--tui-mode", "fullscreen"]);
  await tui.waitForScreen(bottom(alpha()));
  // The list sits two rows under the tab row; the editor is drawn there instead.
  const tabRow = (tabs) => tui.screen().split("\n").indexOf(tabs) + 1;
  // Integer editor: a click where `mode` sits in the list.
  tui.keys("Down", "Enter");
  const count = bottom(countEditor("", ""));
  await tui.waitForScreen(count);
  tui.click(4, tabRow(" [alpha]  beta") + 4);
  tui.type("7");
  await tui.waitForScreen(bottom(countEditor("7", "")));
  tui.keys("Escape");
  await tui.waitForScreen(bottom(alpha({ cursor: 1, description: "How many alphas. Default: 10." })));
  // Open-enum editor: a click where `tone` sits in the list.
  tui.keys("Right", "Down", "e");
  const tone = (input) => bottom(editor(" alpha  [beta]", "tone", "Beta tone. Default: low.", input, ""));
  await tui.waitForScreen(tone(""));
  tui.click(4, tabRow("  alpha  [beta]") + 3);
  tui.type("7");
  await tui.waitForScreen(tone("7"));
  tui.keys("Enter");
  await tui.waitForEvent("beta.tone=7");
  assert.deepEqual(tui.events(), ["session_start", "beta.tone=7"]);
  assert.deepEqual(file(), { beta: { tone: "7" } });
});
