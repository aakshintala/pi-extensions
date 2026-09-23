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

async function openRig(t) {
  const tui = await startTui(t, { extensions });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const file = () => {
    const path = join(dirname(tui.home), "agent", "rig.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  };
  tui.type("/rig");
  await tui.waitForScreen(rows(`

────────────────────────────────────────────────────────────────────────────────
/rig
────────────────────────────────────────────────────────────────────────────────
→ rig         [t] Rig settings
${FOOTER}`, 17));
  tui.keys("Enter");
  return { tui, file };
}

const alpha = ({ cursor = 0, enabled = "true", count = "10", description = "Turn alpha on. Default: true." } = {}) => {
  const row = (i, label, value) => `${i === cursor ? "→ " : "  "}${label}${value}`;
  return rows(`

 [alpha]  beta

${row(0, "enabled  ", enabled)}
${row(1, "count    ", count)}
${row(2, "mode     ", "fast")}

  ${description}

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default
${FOOTER}`, 11);
};

test("/rig opens a tab per section with settings and switches tabs with Left/Right", async (t) => {
  const { tui } = await openRig(t);
  // gamma declares no settings, so it has no tab.
  await tui.waitForScreen(alpha());
  tui.keys("Right");
  const beta = rows(`

  alpha  [beta]

→ limit  2

  Beta limit. Default: 2.

  Enter/Space to change · Esc to cancel
  ←/→ to switch tab · r to reset to default
${FOOTER}`, 13);
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
  await tui.waitForScreen(rows(`

 [alpha]  beta

count
How many alphas. Default: 10.

> 99
count must be between 1 and 32

  Enter to save · Esc to go back
${FOOTER}`, 12));
  assert.deepEqual(file(), { alpha: { enabled: false } });

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
