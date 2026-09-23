// /usage data on fixtures (#61): session-folder resolution, local-hour
// bucketing in a UTC+5:30 zone, and cost parsing across usage shapes.
process.env.TZ = "Asia/Kolkata"; // before any Date is made
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUsageData, localHourStart, parseUsageAmount, resolveSessionsDir } from "../extensions/usage/data.ts";
import { buildGraphModel } from "../extensions/usage/graph.ts";

const SESSIONS = fileURLToPath(new URL("./fixtures/usage/sessions", import.meta.url));
const NOW = new Date("2026-09-20T12:00:00+05:30");
const collect = () => collectUsageData({ sessionsDir: SESSIONS, cachePath: null, now: NOW });

test("session folder: PI_CODING_AGENT_SESSION_DIR, then the sessionDir setting, then <agentDir>/sessions", () => {
  assert.equal(resolveSessionsDir("/agent", undefined, {}), "/agent/sessions");
  assert.equal(resolveSessionsDir("/agent", "/custom", {}), "/custom");
  assert.equal(resolveSessionsDir("/agent", "/custom", { PI_CODING_AGENT_SESSION_DIR: "/env" }), "/env");
  assert.equal(resolveSessionsDir("/agent", undefined, { PI_CODING_AGENT_SESSION_DIR: "~/s" }), join(homedir(), "s"));
});

test("hours are local: a UTC+5:30 hour starts at :30 UTC", () => {
  assert.equal(new Date(localHourStart(Date.parse("2026-09-20T05:15:00Z"))).toISOString(), "2026-09-20T04:30:00.000Z");
});

test("graph and table agree on today's total in a half-hour zone", async () => {
  const data = await collect();
  // 00:10 IST lands in the 00:00 IST bucket (18:30Z), inside today, not in 18:00Z the day before.
  assert.ok(data.hourly.has(Date.parse("2026-09-19T18:30:00Z")));
  assert.ok(!data.hourly.has(Date.parse("2026-09-19T18:00:00Z")));
  const graph = buildGraphModel(data.hourly, { period: "today", metric: "cost", groupBy: "total", cumulative: false, bounds: data.bounds });
  assert.equal(graph.series[0].total, data.today.totals.cost);
});

test("every cost shape counts: {total}, a number, parts without a total, compaction and tool usage", async () => {
  assert.equal(parseUsageAmount({ input: 1, cost: 2 }).cost, 2);
  assert.equal(parseUsageAmount({ input: 1, cost: { total: 3 } }).cost, 3);
  assert.equal(parseUsageAmount({ input: 1, cost: { input: 1, output: 3 } }).cost, 4);
  const data = await collect();
  assert.equal(data.today.totals.cost, 1 + 2 + 4 + 8 + 16);
  assert.equal(data.today.totals.messages, 3); // compaction and tool usage are not assistant turns
  assert.equal(data.today.providers.get("p1").cost, 7);
  assert.equal(data.today.providers.get("Tools").cost, 24);
  assert.equal(data.allTime.totals.cost, 31 + 5); // plus last week's session
});
