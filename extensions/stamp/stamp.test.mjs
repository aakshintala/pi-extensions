// Stamp module tests: labels per setting, rendering from frozen settings, the
// formatter cache bound, and the one-time pi-stamp.json import.
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../tests/fixtures/tool-display/pi-tui.mjs";
const { createRigSettings, rigSettings } = await import("../../shared/settings/index.ts");
const { MAX_FORMATTERS } = await import("./format.ts");
const { stampRenderer } = await import("./render.ts");
const { frozenSettings, importPiStamp, IMPORTED, SETTINGS } = await import("./settings.ts");
const { isLocale } = await import("./format.ts");

// Every temp dir lives under one root, removed when the file finishes.
const root = mkdtempSync(join(tmpdir(), "stamp-"));
after(() => rmSync(root, { recursive: true, force: true }));

const DEFAULTS = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
const T = Date.UTC(2026, 8, 23, 14, 5, 9); // 2026-09-23 14:05:09 UTC
const theme = { fg: (_color, text) => text };

// Rendered lines of one entry, left padding trimmed.
function render(data, settings = {}, { expanded = false, width = 120 } = {}) {
  const frozen = Object.freeze({ ...DEFAULTS, ...settings });
  const component = stampRenderer(() => frozen)({ type: "custom", customType: "pi-stamp", data }, { expanded }, theme);
  return component?.render(width).map((l) => l.trimStart());
}
const user = (extra = {}) => ({ version: 2, role: "user", timestamp: T, ...extra });
const assistant = (extra = {}) => ({ version: 7, role: "assistant", timestamp: T, ...extra });
const metadata = {
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m1",
  stopReason: "length",
  usage: { input: 1000, output: 234, totalTokens: 1234, estimatedCost: 0.0123 },
};

test("time format follows hourCycle, showSeconds, locale and timeZone", () => {
  assert.deepEqual(render(user()), ["14:05:09"]);
  assert.deepEqual(render(user(), { hourCycle: "12h" }), ["2:05:09 PM"]);
  assert.deepEqual(render(user(), { showSeconds: false }), ["14:05"]);
  assert.deepEqual(render(user(), { timeZone: "Asia/Kolkata" }), ["19:35:09"]);
  assert.deepEqual(render(user(), { locale: "de-DE", dateContext: "always" }), ["23.09.2026 · 14:05:09"]);
  assert.deepEqual(render(user(), { locale: "system" }), [new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(T)]);
});

test("dateContext shows the date on a day change, always or never", () => {
  const yesterday = T - 86_400_000;
  assert.deepEqual(render(user({ previousTimestamp: yesterday })), ["2026-09-23 · 14:05:09"]);
  assert.deepEqual(render(user({ previousTimestamp: T - 1000 })), ["14:05:09"]);
  assert.deepEqual(render(user(), { dateContext: "always" }), ["2026-09-23 · 14:05:09"]);
  assert.deepEqual(render(user({ previousTimestamp: yesterday }), { dateContext: "never" }), ["14:05:09"]);
});

test("responseTiming adds the duration, or first content and total", () => {
  const timed = assistant({ firstContentAt: T + 400, completedAt: T + 2_500 });
  assert.deepEqual(render(timed), ["14:05:09"]);
  assert.deepEqual(render(timed, { responseTiming: "duration" }), ["14:05:09 · 2.5s"]);
  assert.deepEqual(render(timed, { responseTiming: "detailed" }), ["14:05:09 · first 0.4s · total 2.5s"]);
});

test("assistantMetadata, showThinkingLevel, showCompactAbnormalOutcome and showCostSinceUser shape the metadata lines", () => {
  const data = assistant({ metadata, thinkingLevel: "high", estimatedCost: 0.0123, costSinceUser: 0.05 });
  assert.deepEqual(render(data), ["14:05:09"]);
  assert.deepEqual(render(data, { assistantMetadata: "compact" }), ["14:05:09", "m1 · thinking high · stop length · 1,234 tok · est $0.0123"]);
  assert.deepEqual(render(data, { assistantMetadata: "compact", showThinkingLevel: false, showCompactAbnormalOutcome: false }), [
    "14:05:09",
    "m1 · 1,234 tok · est $0.0123",
  ]);
  assert.deepEqual(render(data, { assistantMetadata: "compact", showCostSinceUser: true }), [
    "14:05:09",
    "m1 · thinking high · stop length · 1,234 tok · est $0.0123 · since user $0.05",
  ]);
  assert.deepEqual(render(data, { showCostSinceUser: true }), ["14:05:09", "est $0.0123 · since user $0.05"]);
  assert.deepEqual(render(data, { assistantMetadata: "expanded" }), [
    "14:05:09",
    "api anthropic-messages · provider anthropic · requested m1 · thinking high · stop length",
    "tokens in 1,000 · out 234 · total 1,234 · est cost $0.0123",
  ]);
});

test("showExactTimeline adds exact times when output is expanded", () => {
  const data = assistant({ completedAt: T + 2_500 });
  const exact = [
    "14:05:09",
    `timeline · created 2026-09-23T14:05:09.000Z · unix-ms ${T}`,
    `timeline · completed 2026-09-23T14:05:11.500Z · unix-ms ${T + 2500}`,
  ];
  assert.deepEqual(render(data, {}, { expanded: true }), exact);
  assert.deepEqual(render(data, { showExactTimeline: false }, { expanded: true }), ["14:05:09"]);
  assert.deepEqual(render(data), ["14:05:09"]);
});

test("toolStamps shows recorded tools, and legacy tool entries still render a (hidden) component when off", () => {
  const tools = [{ name: "bash", startedAt: T, completedAt: T + 1_234, outcome: "error" }];
  assert.deepEqual(render(assistant({ tools })), ["14:05:09"]);
  assert.deepEqual(render(assistant({ tools }), { toolStamps: true }), ["14:05:09", "tool bash · 1.2s · error"]);
  const legacy = { version: 1, kind: "tool", toolCallId: "c1", toolName: "read", startedAt: T, completedAt: T + 50, outcome: "success" };
  assert.deepEqual(render(legacy), []);
  assert.deepEqual(render(legacy, { toolStamps: true }), ["tool read · <0.1s · success"]);
});

test("a tool-only response renders no component unless toolStamps is on; entries without the flag render as before", () => {
  const tools = [{ name: "read", startedAt: T, completedAt: T + 100, outcome: "success" }];
  assert.equal(render(assistant({ toolOnly: true, tools })), undefined);
  assert.deepEqual(render(assistant({ toolOnly: true, tools }), { toolStamps: true }), ["14:05:09", "tool read · 0.1s · success"]);
  assert.deepEqual(render(assistant({ tools })), ["14:05:09"]);
  assert.equal(render(assistant({ toolOnly: false })), undefined); // only `true` is ever written
  assert.equal(render(assistant({ runStartedAt: T + 1 })), undefined); // a run starts before its reply
  // Drawn while toolStamps was on, it goes blank when it is turned off.
  let settings = Object.freeze({ ...DEFAULTS, toolStamps: true });
  const shown = stampRenderer(() => settings)({ type: "custom", customType: "pi-stamp", data: assistant({ toolOnly: true }) }, { expanded: false }, theme);
  assert.deepEqual(shown.render(20).map((l) => l.trimStart()), ["14:05:09"]);
  settings = Object.freeze({ ...DEFAULTS });
  assert.deepEqual(shown.render(20), []);
});

test("every version the fork wrote still renders, and malformed data renders nothing", () => {
  assert.deepEqual(render({ version: 1, role: "user", timestamp: T }), ["14:05:09"]);
  assert.deepEqual(render({ version: 3, role: "assistant", timestamp: T, completedAt: T + 1000 }, { responseTiming: "duration" }), [
    "14:05:09 · 1.0s",
  ]);
  assert.deepEqual(render({ version: 5, role: "assistant", timestamp: T, metadata, thinkingLevel: "low" }, { assistantMetadata: "compact" }), [
    "14:05:09",
    "m1 · thinking low · stop length · 1,234 tok · est $0.0123",
  ]);
  assert.deepEqual(render({ version: 6, role: "assistant", timestamp: T, costSinceUser: 0.5 }, { showCostSinceUser: true }), [
    "14:05:09",
    "since user $0.5",
  ]);
  assert.equal(render({ version: 3, role: "user", timestamp: T, completedAt: T }), undefined);
  assert.equal(render({ version: 7, role: "assistant", timestamp: T, extra: 1 }), undefined);
});

test("rendering many stamps over many frames takes one settings snapshot per change", () => {
  const rig = createRigSettings(mkdtempSync(join(root, "stamp-")));
  const section = rig.declare("stamp", SETTINGS);
  let snapshots = 0;
  const values = section.values;
  section.values = () => (snapshots++, values());
  const frozen = frozenSettings(section);
  const settings = frozen.get;
  const renderer = stampRenderer(settings);
  const components = Array.from({ length: 500 }, (_, i) =>
    renderer({ type: "custom", customType: "pi-stamp", data: user({ timestamp: T + i * 1000 }) }, { expanded: false }, theme),
  );
  const frame = () => components.map((c) => c.render(80)[0].trimStart());
  for (let i = 0; i < 5; i++) frame();
  assert.equal(snapshots, 1);
  assert.ok(Object.isFrozen(settings()));
  section.set("showSeconds", false);
  assert.equal(frame()[1], "14:05");
  frame();
  assert.equal(snapshots, 2);
});

test("formatters are reused, and the cache is bounded", () => {
  const Real = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = function (...args) {
    built++;
    return new Real(...args);
  };
  try {
    const zones = Intl.supportedValuesOf("timeZone").slice(0, MAX_FORMATTERS + 1);
    render(user(), { timeZone: zones[0] });
    const before = built;
    for (let i = 0; i < 10; i++) render(user({ timestamp: T + i }), { timeZone: zones[0] });
    assert.equal(built, before, "same zone reuses its formatter");
    for (const zone of zones) render(user(), { timeZone: zone });
    const filled = built;
    render(user(), { timeZone: zones[0] });
    assert.equal(built, filled + 1, "the oldest formatter was evicted");
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

function importDir(piStamp, rig) {
  const d = mkdtempSync(join(root, "stamp-import-"));
  if (piStamp !== undefined) writeFileSync(join(d, "pi-stamp.json"), typeof piStamp === "string" ? piStamp : JSON.stringify(piStamp, null, "\t"));
  if (rig !== undefined) writeFileSync(join(d, "rig.json"), JSON.stringify(rig));
  const run = () => {
    const settings = createRigSettings(d);
    const section = settings.declare("stamp", SETTINGS);
    importPiStamp(section, settings.path, d);
    return section;
  };
  const rigFile = () => (existsSync(join(d, "rig.json")) ? JSON.parse(readFileSync(join(d, "rig.json"), "utf8")) : undefined);
  return { d, run, rigFile };
}

test("pi-stamp.json is imported once: valid non-default values only, and pi-stamp.json is left alone", () => {
  const old = { locale: "system", timeZone: "Asia/Kolkata", assistantMetadata: "off", toolStamps: true, hourCycle: "25h", other: 1 };
  const { d, run, rigFile } = importDir(old);
  const before = readFileSync(join(d, "pi-stamp.json"), "utf8");
  const section = run();
  assert.equal(section.get("locale"), "system");
  assert.equal(section.get("timeZone"), "Asia/Kolkata");
  assert.equal(section.get("toolStamps"), true);
  assert.equal(section.get("hourCycle"), "24h");
  assert.deepEqual(rigFile(), { stamp: { locale: "system", timeZone: "Asia/Kolkata", toolStamps: true } });
  // Later /rig edits, even resetting every stamp setting, are not undone by the next start.
  section.set("toolStamps", false);
  assert.equal(run().get("toolStamps"), false);
  for (const s of SETTINGS) run().reset(s.key);
  assert.deepEqual(rigFile(), {});
  assert.equal(run().get("locale"), "invariant");
  assert.deepEqual(rigFile(), {});
  assert.ok(existsSync(join(d, IMPORTED)));
  assert.equal(readFileSync(join(d, "pi-stamp.json"), "utf8"), before);
});

test("no import when rig.json already has a stamp section, or pi-stamp.json is missing or broken", () => {
  const kept = importDir({ locale: "system" }, { stamp: { showSeconds: false } });
  assert.equal(kept.run().get("locale"), "invariant");
  assert.deepEqual(kept.rigFile(), { stamp: { showSeconds: false } });
  const missing = importDir();
  assert.equal(missing.run().get("locale"), "invariant");
  assert.equal(missing.rigFile(), undefined);
  const broken = importDir("{ not json");
  assert.equal(broken.run().get("locale"), "invariant");
  assert.equal(broken.rigFile(), undefined);
});

test("invalidate() drops themed output, so a theme change restyles the stamp", () => {
  let color = "A";
  const themed = { fg: (_c, text) => `${color}${text}` };
  const frozen = Object.freeze({ ...DEFAULTS });
  const component = stampRenderer(() => frozen)({ type: "custom", customType: "pi-stamp", data: user() }, { expanded: false }, themed);
  assert.equal(component.render(20)[0].trim(), "A14:05:09");
  color = "B";
  assert.equal(component.render(20)[0].trim(), "A14:05:09");
  component.invalidate();
  assert.equal(component.render(20)[0].trim(), "B14:05:09");
});

test("the import is one write of every value", () => {
  const { d } = importDir({ locale: "system", toolStamps: true, showSeconds: false });
  const settings = createRigSettings(d);
  const section = settings.declare("stamp", SETTINGS);
  const writes = [];
  const setMany = section.setMany;
  section.set = (k, v) => writes.push({ [k]: v });
  section.setMany = (changes) => (writes.push(changes), setMany(changes));
  importPiStamp(section, settings.path, d);
  assert.deepEqual(writes, [{ showSeconds: false, locale: "system", toolStamps: true }]);
});

test("locale: POSIX names are imported as BCP 47 tags; only well-formed tags are valid", () => {
  const { run, rigFile } = importDir({ locale: "en_US.UTF-8" });
  assert.equal(run().get("locale"), "en-US");
  assert.deepEqual(rigFile(), { stamp: { locale: "en-US" } });
  for (const good of ["en-US", "de", "de-CH-u-hc-h23", "zh-Hant-TW"]) assert.equal(isLocale(good), true, good);
  for (const bad of ["en_US", "en_US.UTF-8", "local", "posix", "", "e"]) assert.equal(isLocale(bad), false, bad);
});

test("frozenSettings stops following changes once stopped", () => {
  const section = createRigSettings(mkdtempSync(join(root, "stamp-"))).declare("stamp", SETTINGS);
  const frozen = frozenSettings(section);
  section.set("showSeconds", false);
  assert.equal(frozen.get().showSeconds, false);
  frozen.stop();
  section.set("showSeconds", true);
  assert.equal(frozen.get().showSeconds, false);
});

test("the extension factory only registers; the import runs at session_start", async () => {
  const { d, rigFile } = importDir({ locale: "system" });
  process.env.PI_CODING_AGENT_DIR = d;
  const { default: stamp } = await import("./index.ts");
  const handlers = {};
  stamp({ on: (name, h) => (handlers[name] = h), registerEntryRenderer() {}, appendEntry() {} });
  assert.equal(rigFile(), undefined);
  handlers.session_start({}, { mode: "tui", hasUI: false, sessionManager: { getBranch: () => [] } });
  assert.deepEqual(rigFile(), { stamp: { locale: "system" } });
  handlers.session_shutdown({});
});

// Drives the extension through one agent run with a fake Pi and returns the entries it appends.
async function recordRun(responses, userAt, branch = [], { settings = {} } = {}) {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "agent-"));
  const { default: stamp } = await import("./index.ts");
  const handlers = {};
  const entries = [];
  let clock = 0;
  stamp({ on: (name, h) => (handlers[name] = h), registerEntryRenderer() {}, appendEntry: (_type, data) => entries.push(data) }, { now: () => clock });
  // Settings are process-wide (one rig.json per process): set for this run, then restored.
  const section = rigSettings().sections().find((s) => s.name === "stamp");
  for (const [k, v] of Object.entries(settings)) section.set(k, v);
  handlers.session_start({}, { mode: "tui", hasUI: false, sessionManager: { getBranch: () => branch } });
  handlers.message_end({ message: { role: "user", timestamp: userAt } });
  for (const { at, done, user, end, ...message } of responses) {
    if (end) handlers.agent_end({});
    if (user !== undefined) handlers.message_end({ message: { role: "user", timestamp: user } });
    if (end || user !== undefined) continue;
    const m = { role: "assistant", timestamp: at, ...message };
    handlers.turn_start({}, {});
    handlers.message_start({ message: m });
    clock = done;
    handlers.message_end({ message: m });
    handlers.turn_end({ message: m, toolResults: [] });
  }
  handlers.agent_end({});
  handlers.session_shutdown({});
  for (const k of Object.keys(settings)) section.set(k, DEFAULTS[k]);
  return entries;
}
const toolCall = { type: "toolCall", id: "c1", name: "read", arguments: {} };

test("the reply that ends a run is timed from its first tool-only response, and hidden stamps leave the date context alone", async () => {
  const D = Date.UTC(2026, 8, 22, 23, 59, 0);
  const [userStamp, r1, r2, reply] = await recordRun(
    [
      { at: D + 10_000, done: D + 20_000, stopReason: "toolUse", content: [toolCall] },
      { at: D + 90_000, done: D + 95_000, stopReason: "toolUse", content: [{ type: "thinking", thinking: "Hm." }, toolCall] },
      { at: D + 100_000, done: D + 160_000, stopReason: "stop", content: [{ type: "text", text: "Done." }] },
    ],
    D,
  );
  assert.deepEqual([userStamp.timestamp, r1.toolOnly, r2.toolOnly, r2.previousTimestamp, reply.previousTimestamp], [D, true, true, D, D]);
  assert.equal(reply.runStartedAt, D + 10_000);
  assert.equal("runStartedAt" in r2, false);
  // Past midnight since the last drawn stamp, so the date shows; the total is the run's 150s.
  assert.deepEqual(render(reply, { responseTiming: "detailed" }), ["2026-09-23 · 00:00:40 · first n/a · total 150.0s"]);
  // Resumed: the last drawn stamp in the saved branch is the user's, not the later tool-only one.
  const saved = [userStamp, r2].map((data) => ({ type: "custom", customType: "pi-stamp", data }));
  const [next] = await recordRun([], D + 200_000, saved);
  assert.equal(next.previousTimestamp, D);
});

test("tool-only covers aborted and failed responses with calls; a length stop and a call-less abort keep their stamps", async () => {
  const D = Date.UTC(2026, 8, 23, 10, 0, 0);
  const only = async (stopReason, content) => (await recordRun([{ at: D, done: D, stopReason, content }], D - 1000))[1].toolOnly;
  assert.equal(await only("aborted", [toolCall]), true);
  assert.equal(await only("error", [toolCall]), true);
  assert.equal(await only("length", [toolCall]), undefined);
  assert.equal(await only("aborted", []), undefined);
  assert.equal(await only("toolUse", [{ type: "text", text: "Reading." }, toolCall]), undefined);
});

test("a run that ends on an aborted tool-only response does not time the next run's reply", async () => {
  const D = Date.UTC(2026, 8, 23, 10, 0, 0);
  const aborted = { at: D + 1000, done: D + 2000, stopReason: "aborted", content: [toolCall] };
  const reply = { at: D + 61_000, done: D + 62_000, stopReason: "stop", content: [{ type: "text", text: "Hi." }] };
  // The next run starts without a user message (an extension's follow-up), or with one mid-run (a steer).
  for (const between of [{ end: true }, { user: D + 60_000 }]) {
    const entries = await recordRun([aborted, between, reply], D);
    assert.equal("runStartedAt" in entries.at(-1), false, JSON.stringify(between));
  }
});

test("with toolStamps on, tool-only stamps are drawn, so they count for the date context", async () => {
  const D = Date.UTC(2026, 8, 22, 23, 59, 0);
  const responses = [
    { at: D + 90_000, done: D + 95_000, stopReason: "toolUse", content: [toolCall] },
    { at: D + 100_000, done: D + 160_000, stopReason: "stop", content: [{ type: "text", text: "Done." }] },
  ];
  const [, hidden, reply] = await recordRun(responses, D, [], { settings: { toolStamps: true } });
  assert.deepEqual([hidden.previousTimestamp, reply.previousTimestamp], [D, D + 90_000]);
  const saved = [{ type: "custom", customType: "pi-stamp", data: hidden }];
  const [next] = await recordRun([], D + 200_000, saved, { settings: { toolStamps: true } });
  assert.equal(next.previousTimestamp, D + 90_000);
});
