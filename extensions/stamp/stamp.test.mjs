import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../tests/fixtures/tool-display/pi-tui.mjs";
const { stampRenderer, STAMP_ENTRY_TYPE } = await import("./render.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { SETTINGS } = await import("./settings.ts");
const values = { ...Object.fromEntries(SETTINGS.map(({ key, default: value }) => [key, value])), timeZone: "UTC" };
const renderer = stampRenderer(() => values);
let color = "A";
const theme = { fg: (_color, text) => `${color}${text}` };
const plainTheme = { fg: (_color, text) => text };
const entry = (data, currentTheme = theme) => renderer({ type: "custom", customType: STAMP_ENTRY_TYPE, data }, {}, currentTheme);
const runData = () => ({ version: 1, startedAt: Date.UTC(2026, 8, 23, 16, 54, 11), endedAt: Date.UTC(2026, 8, 23, 16, 55) });

test("renders one compact, left-aligned settled-run line with a 12-hour clock", () => {
  const t = Date.UTC(2026, 8, 23, 16, 55);
  assert.deepEqual(entry({ version: 1, startedAt: t - 49_000, endedAt: t }, plainTheme).render(80), ["✻ Worked for 49s · done 4:55 PM"]);
  values.hourCycle = "24h";
  assert.match(entry({ version: 1, startedAt: t - 49_000, endedAt: t }).render(80)[0], /done 16:55$/);
  values.hourCycle = "12h";
});

test("existing component reflects settings changes and truncates to the requested width", () => {
  const component = entry(runData(), plainTheme);
  assert.match(component.render(80)[0], /4:55 PM$/);
  values.hourCycle = "24h";
  assert.match(component.render(80)[0], /16:55$/);
  assert.ok(visibleWidth(component.render(8)[0]) <= 8);
  values.hourCycle = "12h";
});

test("theme changes are picked up when the component is invalidated", () => {
  const component = entry(runData());
  assert.ok(component.render(80)[0].startsWith("A"));
  color = "B";
  component.invalidate();
  assert.ok(component.render(80)[0].startsWith("B"));
  color = "A";
});

test("appends nothing on messages and one entry only at settlement", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "stamp-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { default: stamp } = await import("./index.ts");
  const handlers = {};
  const entries = [];
  stamp({ on: (name, handler) => (handlers[name] = handler), registerEntryRenderer() {}, appendEntry: (type, data) => entries.push({ type, data }) }, { now: (() => { let t = 1000; return () => t++; })() });
  for (const event of ["user", "assistant", "tool"]) handlers.message_end?.({ message: { role: event, timestamp: 1000 } });
  assert.deepEqual(entries, []);
  handlers.agent_start();
  handlers.agent_start(); // retries retain the first start time
  assert.deepEqual(entries, []);
  handlers.agent_settled();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { type: STAMP_ENTRY_TYPE, data: { version: 1, startedAt: 1000, endedAt: 1001 } });
  handlers.agent_start();
  handlers.session_start(); // a replacement session cannot inherit the old run's start
  handlers.agent_settled();
  assert.equal(entries.length, 1);
});

test("ignores historical message stamps, malformed entries and backwards runs", () => {
  for (const old of [
    { version: 2, role: "user", timestamp: Date.now() },
    { version: 7, role: "assistant", timestamp: Date.now() },
    { version: 1, startedAt: 20, endedAt: 10 },
    { version: 1, startedAt: "now", endedAt: 20 },
  ]) assert.equal(entry(old), undefined);
});
