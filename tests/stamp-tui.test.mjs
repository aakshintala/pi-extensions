// Settled-run stamps in a real Pi session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const extensions = [root("extensions/rig/index.ts"), root("tests/fixtures/stamp/index.ts")];
async function start(t, replies) {
  const tui = await startTui(t, { extensions, replies, rows: 24 });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  return tui;
}
const waitForText = async (tui, text, present = true) => {
  const deadline = Date.now() + 20_000;
  while (tui.screen().includes(text) !== present) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}\n${tui.screen()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("writes no stamp before settlement, exactly one afterward, and keeps it on reload", async (t) => {
  const tui = await start(t, ["Hello there."]);
  tui.type("hi");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await waitForText(tui, "✻ Worked for");
  assert.equal((tui.screen().match(/✻ Worked for/g) ?? []).length, 1);
  tui.type("/reload"); tui.keys("Enter");
  await tui.waitForEvent("session_start", 2);
  await waitForText(tui, "✻ Worked for");
  assert.equal((tui.screen().match(/✻ Worked for/g) ?? []).length, 1);
});

test("does not create phantom stamps for input or old message entries", async (t) => {
  const tui = await start(t, []);
  tui.type("just typing");
  await waitForText(tui, "✻ Worked for", false);
  tui.keys("Escape");
  await waitForText(tui, "✻ Worked for", false);
});

test("each settled run gets one line", async (t) => {
  const tui = await start(t, ["First.", "Second."]);
  for (const count of [1, 2]) {
    tui.type(`run ${count}`); tui.keys("Enter");
    await tui.waitForEvent("agent_end", count);
    await waitForText(tui, "✻ Worked for");
    const deadline = Date.now() + 20_000;
    while ((tui.screen().match(/✻ Worked for/g) ?? []).length !== count) {
      if (Date.now() > deadline) throw new Error(tui.screen());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
