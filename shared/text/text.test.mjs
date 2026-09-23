import { test } from "node:test";
import assert from "node:assert/strict";
import { oneLine } from "./index.ts";

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
