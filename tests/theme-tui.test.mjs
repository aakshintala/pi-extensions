// /theme in a real pi (#61): Pi's own picker, live preview, select persists
// through Pi, cancel restores the old theme and writes nothing.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

// Pi saves settings on its write queue, after the redraw, so wait for the file itself.
function waitForSetting(path, key, want) {
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, "utf8"))[key];
    } catch {
      return undefined; // missing or caught mid-write
    }
  };
  return new Promise((resolve, reject) => {
    let watcher;
    const finish = (err) => {
      watcher?.close();
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const check = () => read() === want && finish();
    const timer = setTimeout(
      () => finish(new Error(`settings.json ${key} is ${JSON.stringify(read())}, never ${JSON.stringify(want)}`)),
      20_000,
    );
    try {
      // The directory, not the file: a file watcher goes silent after a tmp + rename write.
      watcher = watch(dirname(path), (_event, name) => (!name || name === basename(path)) && check());
      watcher.on("error", finish);
    } catch (err) {
      return finish(err);
    }
    check(); // after the watcher starts, so no write slips between
  });
}

// /reload awaits Pi's settings write queue before it starts the session again, so once
// session_start number `starts` arrives, any save the steps before it queued is on disk.
async function drainSettings(tui, starts) {
  tui.type("/reload");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", starts);
}

async function open(t) {
  const tui = await startTui(t, { extensions });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  const path = join(dirname(tui.home), "agent", "settings.json");
  const settings = () => JSON.parse(readFileSync(path, "utf8"));
  await tui.waitForScreen(screen("dark"));
  tui.type("/theme");
  tui.keys("Enter");
  await tui.waitForScreen(picker("dark", "dark"));
  tui.keys("Down");
  await tui.waitForScreen(picker("light", "light")); // preview
  return { tui, settings, path };
}

test("/theme previews on move and Esc restores the old theme without saving", async (t) => {
  const { tui, settings } = await open(t);
  tui.keys("Escape");
  await tui.waitForScreen(screen("dark"));
  await drainSettings(tui, 2);
  assert.equal(settings().theme, undefined);
});

test("/theme Enter applies the theme and Pi saves it", async (t) => {
  const { tui, path } = await open(t);
  tui.keys("Enter");
  await tui.waitForScreen(screen("light"));
  await waitForSetting(path, "theme", "light");
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
  await drainSettings(tui, 3);
  assert.equal(readFileSync(path, "utf8"), auto);
});
