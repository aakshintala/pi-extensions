// /theme without live preview (#61 review): off Pi 0.87.x the internal theme
// slot is never written. Moving only moves the cursor, cancel changes nothing,
// and select goes through Pi's setTheme(name).
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { scriptedSession } from "./helpers/session.mjs";

const theme = (await import("../extensions/theme/index.ts")).default;
const SLOT = Symbol.for("@earendil-works/pi-coding-agent:theme");
const DOWN = "\x1b[B";

// Runs /theme with the given keys against a stub TUI; returns the setTheme calls
// and the active theme's name after each key.
async function run(t, piVersion, keys) {
  initTheme("dark");
  const { session } = await scriptedSession(t, { extensions: [(pi) => theme(pi, piVersion)] });
  const calls = [];
  const active = [];
  session.extensionRunner.setUIContext(
    {
      notify() {},
      theme: globalThis[SLOT],
      getTheme: (name) => ({ name, fg: (_k, text) => text }),
      setTheme: (name) => (calls.push(name), { success: true }),
      custom: (factory) =>
        new Promise((done) => {
          const view = factory({ invalidate() {}, requestRender() {} }, globalThis[SLOT], {}, done);
          for (const key of keys) {
            view.handleInput(key);
            active.push(globalThis[SLOT].name);
          }
        }),
    },
    "tui",
  );
  await session.prompt("/theme");
  return { calls, active };
}

test("off Pi 0.87.x, moving does not preview and Esc changes nothing", async (t) => {
  assert.deepEqual(await run(t, "0.88.0", [DOWN, "\x1b"]), { calls: [], active: ["dark", "dark"] });
});

test("off Pi 0.87.x, Enter still applies the theme through setTheme(name)", async (t) => {
  assert.deepEqual(await run(t, "0.88.0", [DOWN, "\r"]), { calls: ["light"], active: ["dark", "dark"] });
});

test("on Pi 0.87.x, moving previews and Esc restores", async (t) => {
  assert.deepEqual(await run(t, "0.87.1", [DOWN, "\x1b"]), { calls: [], active: ["light", "dark"] });
});
