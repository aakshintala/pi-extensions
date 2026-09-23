// /usage rendering (#61 review): names from session files never carry terminal
// sequences to the screen.
process.env.TZ = "Asia/Kolkata";
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { collectUsageData } from "../extensions/usage/data.ts";

const { UsageComponent } = await import("../extensions/usage/index.ts");
const plain = { fg: (_k, t) => t, bold: (t) => t };
const EVIL = fileURLToPath(new URL("./fixtures/usage/evil", import.meta.url));

test("provider, model and thinking-level names are drawn without terminal sequences", async () => {
  const data = await collectUsageData({ sessionsDir: EVIL, cachePath: null, now: new Date("2026-09-20T12:00:00+05:30") });
  const view = new UsageComponent(plain, data, () => 40, () => {}, () => {});
  const screens = [];
  view.handleInput("v"); // table
  view.handleInput("\r"); // expand the provider: its model row
  screens.push(view.render(100));
  view.handleInput("v"); // graph, by provider
  screens.push(view.render(100));
  view.handleInput("g"); // by model
  screens.push(view.render(100));
  view.handleInput("g"); // by thinking level
  screens.push(view.render(100));
  const text = screens.flat().join("\n");
  assert.doesNotMatch(text, /[\x1b\x07]/);
  for (const name of ["provider", "model", "high"]) assert.match(text, new RegExp(name));
});
