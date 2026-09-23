import { test } from "node:test";
import assert from "node:assert/strict";
import { editorFocused } from "./index.ts";

const fn = () => {};
const editor = () => ({ onSubmit: fn, getText: fn, handleInput: fn });
/** Pi 0.87's root: seven containers, the fifth holding `slot`. */
const tree = (slot, focused = slot) => ({
  children: [{}, {}, {}, {}, { children: [slot] }, {}, {}],
  getFocusedComponent: () => focused,
});

test("the main editor in the slot and in focus", () => {
  assert.equal(editorFocused(tree(editor()), "0.87.1"), true);
});

test("a picker in the editor slot is not the editor", () => {
  const picker = { handleInput: fn, getText: fn }; // no onSubmit
  assert.equal(editorFocused(tree(picker), "0.87.1"), false);
});

test("the editor in the slot but something else focused", () => {
  assert.equal(editorFocused(tree(editor(), { handleInput: fn }), "0.87.1"), false);
});

test("another Pi version never matches", () => {
  assert.equal(editorFocused(tree(editor()), "0.88.0"), false);
});

test("a missing or short tree is not the editor", () => {
  assert.equal(editorFocused(undefined, "0.87.1"), false);
  assert.equal(editorFocused({ children: [] }, "0.87.1"), false);
});
