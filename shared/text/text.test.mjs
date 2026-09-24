import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCount, oneLine } from "./index.ts";

test("oneLine strips 7- and 8-bit sequences and keeps printable text", () => {
  assert.equal(oneLine("\x1b]0;spoofed\x07title"), "title");
  assert.equal(oneLine("\x9d0;pwned\x07hello"), "hello");
  assert.equal(oneLine("a\x1b]0;x\x9cb"), "ab");
  assert.equal(oneLine("x\x1b_pi:c\x07y"), "xy");
  assert.equal(oneLine("\x1b[2J\x9b31mred"), "red");
  assert.equal(oneLine("one\n\n two\r\nthree"), "one two three");
  assert.equal(oneLine("héllo 世界 🎉"), "héllo 世界 🎉");
});

test("keepSgr removes every sequence but colours and styles", async () => {
  const { keepSgr } = await import("./index.ts");
  assert.equal(keepSgr("\x1b[1;31mred\x1b[0m \x1b[38:5:208mo\x1b[m"), "\x1b[1;31mred\x1b[0m \x1b[38:5:208mo\x1b[m");
  assert.equal(keepSgr("a\x1b[2Jb\x1b]0;t\x07c\x9b31md\x1bce"), "abcde");
  assert.equal(keepSgr("tab\there\n"), "tab\there\n", "control characters are left alone");
});

test("unfinished finds a sequence cut off at the end", async () => {
  const { unfinished } = await import("./index.ts");
  for (const s of ["abc", "a\x1b[31m", "a\x1b]0;t\x07", "a\x1b]0;t\x1b\\", "a\x1bc", ""]) assert.equal(unfinished(s), s.length, JSON.stringify(s));
  for (const s of ["a\x1b", "a\x1b[", "a\x1b[3", "a\x1b]0;ti", "a\x9b3", "a\x1bP1$"]) assert.equal(unfinished(s), 1, JSON.stringify(s));
});

test("formatCount switches unit only where the rounded text would reach the next one", () => {
  assert.deepEqual(
    [0, 999, 1000, 9949, 9950, 9999, 999_499, 999_500, 999_999, 9_949_999, 9_950_000].map((n) => formatCount(n)),
    ["0", "999", "1.0k", "9.9k", "10k", "10k", "999k", "1.0M", "1.0M", "9.9M", "10M"],
  );
  // Negative control: a naive "fixed unit, then toFixed" formatter prints the
  // boundary values this test exists to catch. Confirm it actually fails them,
  // so a regression that reintroduces that shape gets caught here too.
  const naive = (n) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`);
  assert.equal(naive(9999), "10.0k");
  assert.notEqual(naive(9999), formatCount(9999));
  assert.equal(naive(999_999), "1000.0k");
  assert.notEqual(naive(999_999), formatCount(999_999));
});

test("formatCount takes a custom zero string", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(0, { zero: "-" }), "-");
});

test("formatCount decimals:'always' keeps one decimal except when it's exactly zero", () => {
  assert.deepEqual(
    [951, 3700, 16_400, 110_600, 20_000, 999_999].map((n) => formatCount(n, { decimals: "always" })),
    ["951", "3.7k", "16.4k", "110.6k", "20k", "1M"],
  );
});
