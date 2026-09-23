import { test } from "node:test";
import assert from "node:assert/strict";
import "../../tests/fixtures/tool-display/pi-tui.mjs";

const { RENDERERS } = await import("./index.ts");
const theme = { fg: (_k, t) => t, bold: (t) => t };
const ctx = (args) => ({ args, cwd: "/w", isPartial: false, isError: false, expanded: false });
const done = { expanded: false, isPartial: false };

test("edit arguments of an unexpected shape fall back to the result text", () => {
  const result = { content: [{ type: "text", text: "Successfully replaced 1 block(s) in b.txt." }] };
  const lines = RENDERERS.edit.renderResult(result, done, theme, ctx({ path: "b.txt", edits: "not an array" })).render(80);
  assert.deepEqual(lines, ["   ⎿  Successfully replaced 1 block(s) in b.txt."]);
});
