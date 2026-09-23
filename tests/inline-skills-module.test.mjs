// inline-skills module tests: token detection, the injected message, the autocomplete
// provider, the input path, and the editor patch's shape guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./fixtures/tool-display/pi-tui.mjs";
const ext = await import("../extensions/inline-skills/index.ts");
const { namedSkills, patchEditor, skillMessage, skillProvider } = ext;

const skill = (name) => ({ name, description: `${name} skill`, path: `/s/${name}/SKILL.md` });
const SKILLS = ["grilling", "grill-with-docs", "setup-grill", "tdd"].map(skill);
const names = (list) => list.map((s) => s.name);

test("token detection: boundaries, case, second slash, colon, dedup and loaded", () => {
  const found = (text, loaded = [], commands = []) => names(namedSkills(text, () => SKILLS, new Set(loaded), () => commands));
  assert.deepEqual(found("use /tdd, (/grilling) and /TDD"), ["tdd", "grilling"]);
  assert.deepEqual(found("/tdd first"), ["tdd"]);
  assert.deepEqual(found("a/tdd /usr/tdd /tdd/x /tdd:x /tdd-x /nope"), []);
  assert.deepEqual(found("/tdd and /grilling", ["tdd"]), ["grilling"]);
  assert.deepEqual(found("/tdd and /grilling", [], ["tdd"]), ["grilling"], "a command wins at the start");
});

test("a message with no `/` never lists skills", () => {
  const skills = () => assert.fail("skills listed for a message without a slash");
  assert.deepEqual(namedSkills("an ordinary prompt", skills, new Set()), []);
});

test("skill message: fenced bodies, names in details", () => {
  const block = { name: "m", location: "/s/m/SKILL.md", content: "a ```` b\n</skill>", userMessage: undefined };
  const msg = skillMessage([block]);
  assert.equal(msg.customType, "inline-skill");
  assert.equal(msg.display, true);
  assert.deepEqual(msg.details, { names: ["m"], skills: [block] });
  assert.ok(msg.content.endsWith("Skill `m` (/s/m/SKILL.md). Its relative paths start at /s/m.\n`````markdown\na ```` b\n</skill>\n`````"), msg.content);
});

// Pi's provider stand-in: records delegated calls.
function provider() {
  const calls = [];
  const current = {
    triggerCharacters: ["#"],
    getSuggestions: async (lines) => (calls.push(["get", lines[0]]), { items: [{ value: "pi", label: "pi" }], prefix: "x" }),
    applyCompletion: (lines, line, col, item) => (calls.push(["apply", item.label]), { lines, cursorLine: line, cursorCol: col }),
    shouldTriggerFileCompletion: () => false,
  };
  return { p: skillProvider(() => SKILLS, current), calls };
}
const get = (p, text, lines = [text]) => p.getSuggestions(lines, lines.length - 1, lines.at(-1).length, { signal: new AbortController().signal });

test("provider owns a mid-message /word, prefix matches first", async () => {
  const { p, calls } = provider();
  const r = await get(p, "please /gri");
  assert.deepEqual(r.items.map((i) => i.label), ["grill-with-docs", "grilling", "setup-grill"]);
  assert.equal(r.prefix, "gri");
  assert.deepEqual((await get(p, "x /t")).items.map((i) => i.label), ["tdd", "grill-with-docs", "setup-grill"], "prefix before substring");
  assert.deepEqual((await get(p, "x /")).items.length, 4, "a bare / lists every skill");
  assert.deepEqual((await get(p, "", ["first line", "/td"])).items.map((i) => i.label), ["tdd"], "a later line is mid-message");
  assert.equal(await get(p, "try /zzq"), null, "no match: no list, and no file completion");
  assert.deepEqual(calls, []);
  assert.equal(p.triggerCharacters[0], "#");
  assert.equal(p.shouldTriggerFileCompletion(["x"], 0, 1), false);
});

test("provider leaves start-of-message / and paths to Pi", async () => {
  const { p, calls } = provider();
  for (const text of ["/gri", "  /gri", "see /usr/lo", "a/gr"]) assert.equal((await get(p, text)).items[0].label, "pi");
  assert.deepEqual(calls.map((c) => c[1]), ["/gri", "  /gri", "see /usr/lo", "a/gr"]);
});

test("provider completion replaces the token and adds one space", async () => {
  const { p, calls } = provider();
  const { items } = await get(p, "run /gr");
  const at = (text, col, item = items[0]) => p.applyCompletion([text], 0, col, item, "gr");
  assert.deepEqual(at("run /gr now", 7), { lines: ["run /grill-with-docs now"], cursorLine: 0, cursorCol: 20 });
  assert.deepEqual(at("run /gr", 7), { lines: ["run /grill-with-docs "], cursorLine: 0, cursorCol: 21 });
  at("x", 1, { value: "pi", label: "pi" });
  assert.deepEqual(calls, [["apply", "pi"]], "Pi's own items go to Pi");
});

test("the input handler returns at once; reads finish before the turn starts", async () => {
  const handlers = {};
  const pi = {
    on: (name, h) => (handlers[name] = h),
    registerMessageRenderer: () => {},
    getCommands: () => [{ name: "skill:tdd", source: "skill", sourceInfo: { path: new URL("./fixtures/inline-skills/skills/tdd/SKILL.md", import.meta.url).pathname } }],
  };
  ext.default(pi);
  const result = handlers.input({ type: "input", text: "use /tdd", source: "interactive" }, {});
  assert.equal(result, undefined, "no transform, and no promise to wait on");
  const started = await handlers.before_agent_start({}, { ui: { notify: assert.fail } });
  assert.match(started.message.content, /Body of tdd\./);
  assert.equal(handlers.input({ type: "input", text: "use /tdd", source: "interactive" }, {}), undefined);
  assert.equal(await handlers.before_agent_start({}, {}), undefined, "already loaded");
});

// A real CustomEditor mounted where Pi mounts it; counts autocomplete triggers.
const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
function mounted() {
  const editor = new CustomEditor({ requestRender() {} }, { borderColor: (s) => s, selectList: {} }, { matches: () => false });
  let triggers = 0;
  editor.tryTriggerAutocomplete = () => void triggers++;
  const type = (text) => {
    for (const c of text) editor.handleInput(c);
    const n = triggers;
    triggers = 0;
    return n;
  };
  return { editor, type, tui: { children: [0, 0, 0, 0, { children: [editor] }] } };
}

test("the editor patch opens the list on a mid-message / plus two word characters", () => {
  const { tui, type } = mounted();
  assert.equal(patchEditor(tui), true);
  assert.equal(patchEditor(tui), true, "patching twice wraps once");
  assert.equal(type("please /g"), 0);
  assert.equal(type("r"), 1);
  assert.equal(type("i"), 1);
  assert.equal(type(" see /us"), 1);
  assert.equal(type("r/lo"), 1, "only /usr, before the second slash");
});

test("the editor patch skips any shape mismatch without throwing", () => {
  for (const tui of [undefined, {}, { children: [] }, { children: [0, 0, 0, 0, { children: [{ handleInput() {} }] }] }]) {
    assert.equal(patchEditor(tui), false);
  }
  const { tui, type } = mounted();
  assert.equal(patchEditor(tui, "0.88.0"), false, "another Pi version");
  assert.equal(type("please /gr"), 0);
  delete tui.children[4].children[0].state;
  assert.equal(patchEditor(tui), false, "no editor state");
});
