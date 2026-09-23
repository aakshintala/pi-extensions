// /theme in a real pi (#61): Pi's own picker, live preview, select persists
// through Pi, cancel restores the old theme and writes nothing.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const extensions = [root("extensions/theme/index.ts"), root("tests/fixtures/theme/probe.ts")];
const BORDER = "─".repeat(80);
const FOOTER = "~/cwd\n0.0%/128k (auto)                                                       harness-1";
const screen = (name, body = "") => `

theme: ${name}
${BORDER}
${body}
${BORDER}
${FOOTER}` + "\n".repeat(body.split("\n").length === 1 ? 17 : 16);
const picker = (name, cursor) =>
  screen(name, `${cursor === "dark" ? "→" : " "} dark        (current)\n${cursor === "light" ? "→" : " "} light`);

async function open(t) {
  const tui = await startTui(t, { extensions });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const settings = () => JSON.parse(readFileSync(join(dirname(tui.home), "agent", "settings.json"), "utf8"));
  await tui.waitForScreen(screen("dark"));
  tui.type("/theme");
  tui.keys("Enter");
  await tui.waitForScreen(picker("dark", "dark"));
  tui.keys("Down");
  await tui.waitForScreen(picker("light", "light")); // preview
  return { tui, settings };
}

test("/theme previews on move and Esc restores the old theme without saving", async (t) => {
  const { tui, settings } = await open(t);
  tui.keys("Escape");
  await tui.waitForScreen(screen("dark"));
  assert.equal(settings().theme, undefined);
});

test("/theme Enter applies the theme and Pi saves it", async (t) => {
  const { tui, settings } = await open(t);
  tui.keys("Enter");
  await tui.waitForScreen(screen("light"));
  assert.equal(settings().theme, "light");
});

// After /reload with an automatic light/dark setting: the reload notice sits above.
const RELOADED = " Reloaded keybindings, extensions, skills, prompts, themes, and context files";
const autoScreen = (name, body = "") =>
  [`\n\n${RELOADED}`, "", `theme: ${name}`, BORDER, body, BORDER, FOOTER].join("\n") +
  "\n".repeat(body.split("\n").length === 1 ? 15 : 14);

test("/theme cancel keeps Pi following the terminal's light/dark scheme", async (t) => {
  const tui = await startTui(t, { extensions });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const path = join(dirname(tui.home), "agent", "settings.json");
  const auto = JSON.stringify({ quietStartup: true, theme: "light/dark" });
  writeFileSync(path, auto);
  tui.type("/reload");
  tui.keys("Enter");
  await tui.waitForScreen(autoScreen("dark"));

  tui.type("/theme");
  tui.keys("Enter");
  await tui.waitForScreen(autoScreen("dark", "→ dark        (current)\n  light"));
  tui.keys("Down");
  await tui.waitForScreen(autoScreen("light", "  dark        (current)\n→ light")); // preview
  tui.keys("Escape");
  await tui.waitForScreen(autoScreen("dark"));

  tui.type("\x1b[?997;2n"); // the terminal reports that it switched to light
  await tui.waitForScreen(autoScreen("light"));
  assert.equal(readFileSync(path, "utf8"), auto);
});
