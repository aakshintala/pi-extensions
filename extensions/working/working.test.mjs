import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveGroup, startTui } from "../../tests/helpers/tui.mjs";

const EXT = new URL("./index.ts", import.meta.url).pathname;
const GATE = new URL("../../tests/fixtures/queue/gate.ts", import.meta.url).pathname;
const gateCall = [{ type: "toolCall", id: "g1", name: "gate", arguments: {} }];
const { workingLabel } = await import("./index.ts");

test("the accent moves through the label but the elapsed time advances only each second", () => {
  const theme = { fg: (_color, letter) => `[${letter}]` };
  assert.equal(workingLabel("Thinking", 0, theme), "[T]hinking · 0s");
  assert.equal(workingLabel("Thinking", 125, theme), "T[h]inking · 0s");
  assert.equal(workingLabel("Running tool", 1000, theme), "Running [t]ool · 1s");
});

test("the editor shows model and tool phases in its existing working border", async (t) => {
  const tui = await startTui(t, { extensions: [EXT, GATE], replies: [gateCall, "Done."] });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("gate_waiting");
  const deadline = Date.now() + 10_000;
  while (!/── .? Running tool · \d+s/.test(tui.screen()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.match(tui.screen(), /── .? Running tool · \d+s/);
  writeFileSync(join(tui.cwd, "release-1"), "");
  await tui.waitForEvent("agent_end");
  assert.doesNotMatch(tui.screen(), /Running tool/);
});
