// /context's terminal sanitiser (#61 review): captured text keeps its lines but
// never carries a terminal sequence, terminated or not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInlineText, normalizePreviewText } from "../extensions/context/text.ts";

test("terminated OSC, DCS and CSI sequences are removed and line breaks kept", () => {
  assert.equal(normalizePreviewText("a\x1b]0;title\x07b\n\x1bP1$qm\x1b\\c\x1b[31md\x9d8;;x\x9ce"), "ab\ncde");
});

test("an unterminated OSC string is dropped with its payload", () => {
  assert.equal(normalizePreviewText("keep\nthis\x1b]0;evil title"), "keep\nthis");
  assert.equal(normalizePreviewText("keep\x9d0;evil title"), "keep");
  assert.equal(normalizeInlineText("model \x1b]8;;http://x"), "model");
});
