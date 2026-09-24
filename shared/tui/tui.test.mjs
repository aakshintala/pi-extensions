import { test } from "node:test";
import assert from "node:assert/strict";
import "../../tests/fixtures/tool-display/pi-tui.mjs"; // lets index.ts load pi-tui in plain node

const { editorFocused } = await import("./index.ts");

// A real CustomEditor mounted where Pi mounts it, with Pi's app actions (as Pi's main
// editor has).
const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
function editor({ main = true } = {}) {
  const e = new CustomEditor({ requestRender() {} }, { borderColor: (s) => s, selectList: {} }, { matches: () => false });
  if (main) e.onAction("app.clear", () => {});
  return e;
}
/** Pi 0.87's root: seven containers, the fifth holding `slot`. */
const tree = (slot, focused = slot) => ({
  children: [{}, {}, {}, {}, { children: [slot] }, {}, {}],
  getFocusedComponent: () => focused,
});

test("the main editor in the slot and in focus", () => {
  assert.equal(editorFocused(tree(editor()), "0.87.1"), true);
});

test("a picker in the editor slot is not the editor", () => {
  const picker = { handleInput() {}, getText: () => "" };
  assert.equal(editorFocused(tree(picker), "0.87.1"), false);
});

test("a CustomEditor without Pi's app actions (a ui.custom panel) is not the main editor", () => {
  assert.equal(editorFocused(tree(editor({ main: false }))), false);
});

test("the editor in the slot but something else focused", () => {
  assert.equal(editorFocused(tree(editor(), { handleInput() {} }), "0.87.1"), false);
});

test("another Pi version never matches", () => {
  assert.equal(editorFocused(tree(editor()), "0.88.0"), false);
});

test("a missing or short tree is not the editor", () => {
  assert.equal(editorFocused(undefined, "0.87.1"), false);
  assert.equal(editorFocused({ children: [] }, "0.87.1"), false);
});
