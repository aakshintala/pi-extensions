// ask_user panel in a real pi (spec #34, ADR 0001): bottom panel under the transcript,
// inline free text, tabs, multi-select, skipping, review with a note, Esc.
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSION = fileURLToPath(new URL("../extensions/ask-user/index.ts", import.meta.url));
const Q = (header, extra = {}) => ({
  question: `Which ${header}?`,
  header,
  options: [{ label: "Alpha", description: "The first" }, { label: "Beta" }],
  ...extra,
});
const pad = (text) => text + "\n".repeat(24 - text.replace(/^\n/, "").split("\n").length);

async function ask(t, questions) {
  const tui = await startTui(t, {
    extensions: [EXTENSION],
    replies: [[{ type: "toolCall", id: "c1", name: "ask_user", arguments: { questions } }], "done"],
  });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  tui.type("ask");
  tui.keys("Enter");
  return tui;
}

// The transcript above the panel, and the finished transcript after the tool result.
const ABOVE = `

 ask



 ask_user

`;
const after = (result, footer) =>
  pad(`

 ask



 ask_user
${result}


 done

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
${footer}`);

test("one question: panel under the transcript, inline free text, submits on Enter", async (t) => {
  const tui = await ask(t, [Q("db")]);
  const footer = "↑2 ↓34 W2 CH0.0% 0.0%/128k (auto)                                      harness-1";
  const panel = (last, cursor) =>
    pad(`${ABOVE}
Which db?

${cursor === 0 ? "→" : " "} 1. Alpha
      The first
  2. Beta
${last}

  ↑↓ move · Enter choose · Esc cancel
~/cwd
${footer}`);
  await tui.waitForScreen(panel("  3. Type your own answer", 0));
  tui.keys("Up");
  await tui.waitForScreen(panel("→ 3. Type your own answer", 2));
  tui.type("my own words");
  await tui.waitForScreen(panel("→ 3. my own words", 2));
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(after(' db: "my own words"', "↑49 ↓35 R2 W49 CH2.1% 0.1%/128k (auto)                                 harness-1"));
});

test("several questions: tabs, multi-select, skipping, review note and jumping back", async (t) => {
  const tui = await ask(t, [Q("db"), Q("cache", { multiSelect: true }), { question: "Anything else?", header: "extra" }]);
  const footer = "↑2 ↓80 W2 CH0.0% 0.1%/128k (auto)                                      harness-1";
  const screen = (tabs, body) => pad(`${ABOVE}
 ${tabs}

${body}
~/cwd
${footer}`);
  const db = (tabs, pointer = "→ ", tick = "") =>
    screen(tabs, `Which db?

${pointer}1. Alpha${tick}
      The first
  2. Beta
  3. Type your own answer

  ↑↓ move · Enter choose · Tab/←→ switch · Esc cancel`);
  const cache = (tabs, a, b, pointer = 0) =>
    screen(tabs, `Which cache?

${pointer === 0 ? "→" : " "} [${a}] Alpha
      The first
${pointer === 1 ? "→" : " "} [${b}] Beta
      Type your own answer

  ↑↓ move · Space toggle · Enter confirm · Tab/←→ switch · Esc cancel`);
  const review = (tabs, answers, note, submit = false) =>
    screen(tabs, `Review your answers

${answers}

${submit ? " " : "→"} ${note}
${submit ? "→" : " "} Submit answers

  Enter on an answer to change it · Tab/←→ switch · Esc cancel`);

  await tui.waitForScreen(db("[db]  cache   extra   Review "));
  tui.keys("Enter");
  await tui.waitForScreen(cache(" db ✓  [cache]  extra   Review ", " ", " "));
  tui.keys("Space", "Down", "Space");
  await tui.waitForScreen(cache(" db ✓  [cache ✓]  extra   Review ", "x", "x", 1));
  tui.keys("Up", "Space");
  await tui.waitForScreen(cache(" db ✓  [cache ✓]  extra   Review ", " ", "x", 0));
  tui.keys("Enter");
  await tui.waitForScreen(
    screen(" db ✓   cache ✓  [extra]  Review ", `Anything else?

→ 1. Type your own answer

  ↑↓ move · Enter choose · Tab/←→ switch · Esc cancel`),
  );
  tui.keys("Tab"); // skip "extra"
  const tabs = " db ✓   cache ✓   extra  [Review]";
  await tui.waitForScreen(review(tabs, "  db: Alpha\n  cache: Beta\n  extra: skipped", "Add a note to the agent (optional)"));
  tui.type("keep it small");
  await tui.waitForScreen(review(tabs, "  db: Alpha\n  cache: Beta\n  extra: skipped", "keep it small"));
  tui.keys("Up", "Up", "Up", "Enter"); // jump back to "db"
  await tui.waitForScreen(db("[db ✓]  cache ✓   extra   Review ", "→ ", " ✓"));
  tui.keys("Down", "Enter", "Tab", "Tab");
  await tui.waitForScreen(review(tabs, "  db: Beta\n  cache: Beta\n  extra: skipped", "keep it small"));
  tui.keys("Enter");
  await tui.waitForScreen(review(tabs, "  db: Beta\n  cache: Beta\n  extra: skipped", "keep it small", true));
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(
    after(" db: Beta\n cache: Beta\n extra: skipped\n note: keep it small", "↑105 ↓81 R2 W105 CH1.0% 0.2%/128k (auto)                               harness-1"),
  );
});

test("Esc cancels the panel", async (t) => {
  const tui = await ask(t, [Q("db"), Q("cache")]);
  await tui.waitForScreen(
    pad(`${ABOVE}
 [db]  cache   Review

Which db?

→ 1. Alpha
      The first
  2. Beta
  3. Type your own answer

  ↑↓ move · Enter choose · Tab/←→ switch · Esc cancel
~/cwd
↑2 ↓64 W2 CH0.0% 0.1%/128k (auto)                                      harness-1`),
  );
  tui.keys("Escape");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(after(" cancelled", "↑77 ↓65 R2 W77 CH1.3% 0.1%/128k (auto)                                 harness-1"));
});
