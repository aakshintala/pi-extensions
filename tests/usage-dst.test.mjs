// /usage bucketing across DST changes (#61 review), in America/New_York.
process.env.TZ = "America/New_York"; // before any Date is made
import { test } from "node:test";
import assert from "node:assert/strict";
import { localHourStart } from "../extensions/usage/data.ts";
import { buildGraphModel } from "../extensions/usage/graph.ts";

test("the two 01:00 hours of the 2026-11-01 fall-back stay separate buckets", () => {
  const edt = localHourStart(Date.parse("2026-11-01T05:30:00Z")); // 01:30 EDT
  const est = localHourStart(Date.parse("2026-11-01T06:30:00Z")); // 01:30 EST
  assert.equal(new Date(edt).toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(new Date(est).toISOString(), "2026-11-01T06:00:00.000Z");
});

test("day buckets follow local midnights across the 2026-03-08 spring-forward", () => {
  const midnight = (s) => new Date(`${s}T00:00:00`).getTime();
  const at = Date.parse("2026-03-10T04:30:00Z"); // 00:30 EDT on 10 March
  const cell = { messages: 1, cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const hourly = new Map([[localHourStart(at), new Map([["p\u0000m\u0000", cell]])]]);
  const bounds = {
    todayMs: midnight("2026-03-12"),
    weekStartMs: midnight("2026-03-09"),
    lastWeekStartMs: midnight("2026-03-02"),
    last30DaysStartMs: midnight("2026-03-01"),
    nowMs: Date.parse("2026-03-12T16:00:00Z"),
  };
  const model = buildGraphModel(hourly, { period: "last30Days", metric: "cost", groupBy: "total", cumulative: false, bounds });
  assert.ok(model.bucketStarts.every((b) => new Date(b).getHours() === 0), "every day bucket starts at local midnight");
  const day = model.series[0].points.findIndex((v) => v > 0);
  assert.equal(new Date(model.bucketStarts[day]).getDate(), 10);
});
