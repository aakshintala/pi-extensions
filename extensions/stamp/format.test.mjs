import { test } from "node:test";
import assert from "node:assert/strict";
const { formatStampLabel, isLocale, isTimeZone } = await import("./format.ts");

const settings = { hourCycle: "12h", locale: "en-US", timeZone: "UTC" };
const at = (h, m) => Date.UTC(2026, 8, 23, h, m);

test("same-day runs show the time; a run crossing midnight shows the date too", () => {
  assert.equal(formatStampLabel(at(16, 55), at(16, 6), settings), "4:55 PM");
  assert.match(formatStampLabel(at(0, 5), at(23, 50) - 86_400_000, settings) ?? "", / · 12:05 AM$/);
});

test("repeated labels reuse cached formatters instead of constructing them", () => {
  const Real = Intl.DateTimeFormat;
  let constructed = 0;
  Intl.DateTimeFormat = function (...args) {
    constructed++;
    return new Real(...args);
  };
  try {
    formatStampLabel(at(16, 55), at(16, 6), settings);
    const afterFirst = constructed;
    assert.ok(afterFirst <= 2);
    formatStampLabel(at(17, 2), at(16, 6), settings);
    assert.equal(constructed, afterFirst);
  } finally {
    Intl.DateTimeFormat = Real;
  }
});

test("validators accept good values and reject bad ones", () => {
  assert.ok(isLocale("en-US") && isTimeZone("UTC"));
  assert.ok(!isLocale("1234") && !isTimeZone("Not/AZone"));
});
