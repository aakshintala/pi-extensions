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
