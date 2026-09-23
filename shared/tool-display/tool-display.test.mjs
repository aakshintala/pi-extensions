import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../tests/fixtures/tool-display/pi-tui.mjs";

const td = await import("./index.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

// Records every theme key used; each key gets its own SGR code so colours survive stripping checks.
function recordingTheme() {
  const keys = [];
  return {
    keys,
    fg: (key, text) => (keys.push(key), `\x1b[38;5;${keys.length}m${text}\x1b[39m`),
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
}
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const plainLines = (ls) => ls.map(plain);

test("unified diff: totals, hunks from each pair, no file reads", () => {
  const d = td.unifiedDiff([
    { oldText: "a\nb\nc", newText: "a\nB\nc\nd" },
    { oldText: "x", newText: "" },
  ]);
  assert.deepEqual(d, { lines: [" a", "-b", "+B", " c", "+d", "@@", "-x"], added: 2, removed: 2, tooLarge: false });

  const theme = recordingTheme();
  assert.deepEqual(plainLines(td.diffBody(theme, d)), [" a", "-b", "+B", " c", "+d", "⋯", "-x"]);
  assert.deepEqual(new Set(theme.keys), new Set(["toolDiffContext", "toolDiffRemoved", "toolDiffAdded", "dim"]));
});

test("unified diff: input over the size cap is not diffed", () => {
  const big = "x\n".repeat(td.DIFF_MAX_CHARS / 2 + 1);
  assert.deepEqual(td.unifiedDiff([{ oldText: big, newText: "" }]), { lines: [], added: 0, removed: 0, tooLarge: true });
});

test("collapsed result shows a few lines and counts the rest; expanded is capped", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  assert.deepEqual(plainLines(td.resultLines(recordingTheme(), "Read 10 lines", body, false, 80)), [
    "   ⎿  Read 10 lines",
    "      line 1",
    "      line 2",
    "      line 3",
    "      line 4",
    "      … +6 lines (ctrl+o to expand)",
  ]);
  assert.equal(td.resultLines(recordingTheme(), "s", body, true, 80).length, 11);

  const long = Array.from({ length: td.EXPANDED_LINES + 50 }, () => "x");
  const expanded = plainLines(td.resultLines(recordingTheme(), "s", long, true, 80));
  assert.equal(expanded.length, td.EXPANDED_LINES + 2);
  assert.equal(expanded.at(-1), "      … +50 lines");
});

test("call line: Claude Code style, bullet coloured by status", () => {
  for (const [status, key] of [["pending", "muted"], ["done", "success"], ["error", "error"]]) {
    const theme = recordingTheme();
    assert.equal(plain(td.callLine(theme, status, "Read", "src/index.ts", 80)), " ⏺ Read(src/index.ts)");
    assert.equal(theme.keys[0], key);
  }
});

test("error lines wrap the whole message in the error colour", () => {
  const theme = recordingTheme();
  const out = plainLines(td.errorLines(theme, "ENOENT: no such file or directory, open 'missing.txt'", false, 40));
  assert.deepEqual(out, ["   ⎿  Error: ENOENT: no such file or", "      directory, open 'missing.txt'"]);
  assert.ok(theme.keys.includes("error"));
  assert.deepEqual(plainLines(td.errorLines(recordingTheme(), "", false, 40)), ["   ⎿  Error: failed"]);
});

test("nothing is wider than the terminal at narrow widths", () => {
  const theme = recordingTheme();
  const body = ["a very long line of output that will not fit in a narrow terminal"];
  for (const w of [8, 12, 20, 40]) {
    const all = [
      td.callLine(theme, "done", "Edit", "some/deeply/nested/path/to/a/file.ts", w),
      ...td.resultLines(theme, "Added 12 lines, removed 3 lines", [...body, ...body, ...body, ...body, ...body], false, w),
      ...td.errorLines(theme, body[0], false, w),
    ];
    for (const l of all) assert.ok(visibleWidth(l) <= w, `width ${w}: ${JSON.stringify(plain(l))}`);
  }
});

test("toolRenderers: partial results draw nothing, errors show, results use the style", () => {
  const r = td.toolRenderers({
    title: "Read",
    arg: (a) => a.path,
    result: (_res, a) => ({ summary: `Read ${a.path}`, body: [] }),
  });
  assert.equal(r.renderShell, "self");
  const ctx = (over) => ({ args: { path: "a.txt" }, cwd: "/w", isPartial: false, isError: false, expanded: false, ...over });
  const res = { content: [{ type: "text", text: "boom in /w/a.txt" }] };
  const theme = recordingTheme();
  assert.deepEqual(plainLines(r.renderCall({ path: "a.txt" }, theme, ctx({ isPartial: true })).render(80)), [" ⏺ Read(a.txt)"]);
  assert.deepEqual(r.renderResult(res, { expanded: false, isPartial: true }, theme, ctx()).render(80), []);
  assert.deepEqual(plainLines(r.renderResult(res, { expanded: false, isPartial: false }, theme, ctx({ isError: true })).render(80)), ["   ⎿  Error: boom in a.txt"]);
  assert.deepEqual(plainLines(r.renderResult(res, { expanded: false, isPartial: false }, theme, ctx()).render(80)), ["   ⎿  Read a.txt"]);
});

test("colours come only from theme keys", () => {
  assert.doesNotMatch(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), /\\x1b|\\u001b|\\e\[/);
});

test("a result without a content array renders instead of throwing", () => {
  assert.equal(td.resultText({}), "");
  assert.equal(td.resultText({ content: "text" }), "");
  const r = td.toolRenderers({ title: "T", arg: () => "", result: () => ({ summary: "ok", body: [] }) });
  const ctx = { args: {}, cwd: "/w", isPartial: false, isError: true, expanded: false };
  assert.deepEqual(plainLines(r.renderResult({}, { expanded: false, isPartial: false }, recordingTheme(), ctx).render(80)), ["   ⎿  Error: failed"]);
});

const READ = { verb: "read", one: "file" };
const EDIT = { verb: "edited", one: "file", lines: (a) => a.lines };
const BASH = { verb: "ran", one: "shell command" };
const TODO = { verb: "updated", many: "todos" };

test("group summary: fixed per-verb wording in order of first use, line totals, no count for countless verbs", () => {
  const theme = recordingTheme();
  const calls = [
    { summary: READ, status: "done" },
    { summary: EDIT, status: "done", args: { lines: { added: 400, removed: 2 } } },
    { summary: READ, status: "done" },
    { summary: TODO, status: "done" },
    { summary: EDIT, status: "done", args: { lines: { added: 42, removed: 10 } } },
    { summary: BASH, status: "done" },
    { summary: TODO, status: "done" },
    { summary: READ, status: "pending" },
  ];
  assert.equal(plain(td.summaryText(theme, calls)), "Read 3 files, edited 2 files +442 −12, updated todos, ran 1 shell command");
  assert.equal(plain(td.summaryText(theme, calls, true)), "thought · read 3 files, edited 2 files +442 −12, updated todos, ran 1 shell command");
});

test("group summary: failed and cancelled calls count under their verb and again in the error colour", () => {
  const theme = recordingTheme();
  const calls = [
    { summary: READ, status: "done" },
    { summary: READ, status: "done" },
    { summary: EDIT, status: "error", args: { lines: { added: 5, removed: 5 } } },
    { summary: READ, status: "cancelled" },
    { summary: BASH, status: "cancelled" },
  ];
  const text = td.summaryText(theme, calls);
  assert.equal(plain(text), "Read 3 files, edited 1 file, ran 1 shell command · 1 failed · 2 cancelled");
  assert.match(text, /\x1b\[38;5;\d+m1 failed/);
  assert.equal(theme.keys.at(-1), "error");
  assert.equal(theme.keys.at(-2), "error");
  assert.equal(plain(td.summaryText(recordingTheme(), [{ summary: READ, status: "error" }])), "Read 1 file · 1 failed");
});

test("outcome of a result: Pi's abort result is a cancel, any other error a failure", () => {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  assert.equal(td.outcomeOf(false, text("ok")), "done");
  assert.equal(td.outcomeOf(true, text("Operation aborted")), "cancelled");
  assert.equal(td.outcomeOf(true, text("ENOENT: no such file")), "error");
  assert.equal(td.outcomeOf(true, text("partial output\n\nCommand aborted")), "cancelled"); // Pi's bash
});

// A session's groups, drawn the way Pi's chat draws its calls: in message order.
const GROUPED = td.toolRenderers({ title: "Read", arg: (a) => a.path, result: () => ({ summary: "Read", body: [] }), summary: READ });
const toolCall = (id, name = "read") => ({ type: "toolCall", id, name, arguments: { path: id } });
// Every call renders once, then each is drawn (Pi redraws a leader when a later call joins).
const draw = (ids, over = {}) => {
  const render = (id) => GROUPED.renderCall({ path: id }, recordingTheme(), { toolCallId: id, args: {}, cwd: "/w", expanded: false, invalidate() {}, ...over });
  ids.forEach(render);
  return ids.flatMap((id) => plainLines(render(id).render(80)));
};

test("groups: a result that arrives before its call is registered still counts", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.settle("e1", false, { content: [] });
  g.track({ role: "assistant", content: [toolCall("e1"), toolCall("e2")] });
  g.settle("e2", false, { content: [] });
  g.endRun();
  assert.deepEqual(draw(["e1", "e2"]), [" ⏺ Read 2 files"]);
});

test("groups: a call revised out of the message leaves its group", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", content: [toolCall("v1"), toolCall("v2")] }, true);
  draw(["v1", "v2"]);
  g.track({ role: "assistant", content: [toolCall("v1")] }, true);
  assert.deepEqual(draw(["v1"]), [" ⠋ Read 1 file"]);
  assert.deepEqual(draw(["v2"]), [" ⏺ Read(v2)"]); // no longer grouped
});

test("groups: a call with an image always shows, since Pi draws the image outside the renderers", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", content: [toolCall("i1"), toolCall("i2")] });
  draw(["i1", "i2"]);
  g.settle("i1", false, { content: [] });
  g.settle("i2", false, { content: [{ type: "image", data: "", mimeType: "image/png" }] });
  assert.deepEqual(draw(["i1", "i2"]), [" ⏺ Read 2 files", " ⏺ Read(i2)"]);
});

test("groups: an aborted message cancels its calls with no result; an errored one fails them", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", stopReason: "aborted", content: [toolCall("a1"), toolCall("a2")] });
  g.track({ role: "assistant", stopReason: "error", content: [toolCall("f1")] });
  g.settle("a1", false, { content: [] });
  assert.deepEqual(draw(["a1", "a2"]), [" ⏺ Read 2 files · 1 cancelled"]);
  assert.deepEqual(draw(["f1"]), [" ⏺ Read 1 file · 1 failed", " ⏺ Read(f1)"]);
});

test("groups: a tool without a summary splits a run, and so does text", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", content: [toolCall("s1"), toolCall("s2"), toolCall("s3", "ls"), toolCall("s4"), { type: "text", text: "then" }, toolCall("s5")] });
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) g.settle(id, false, { content: [] });
  draw(["s1", "s2", "s4", "s5"]); // s3 is drawn by its own tool
  const shown = ["s1", "s2", "s4", "s5"].map((id) => draw([id]));
  assert.deepEqual(shown, [[" ⏺ Read 2 files"], [], [" ⏺ Read 1 file"], [" ⏺ Read 1 file"]]);
});

test("a group still on screen after its session is reset draws without throwing", () => {
  const g = new td.ToolGroups();
  g.track({ role: "assistant", content: [toolCall("r1")] });
  const line = GROUPED.renderCall({}, recordingTheme(), { toolCallId: "r1", args: {}, cwd: "/w", expanded: false, invalidate() {} });
  g.reset();
  assert.doesNotThrow(() => line.render(80));
});

test("groups: an error before the user's abort of a later reply, or of a new prompt, stays failed", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", stopReason: "toolUse", content: [toolCall("u1")] });
  g.settle("u1", true, { content: [{ type: "text", text: "ENOENT" }] });
  g.track({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "The file" }] });
  assert.deepEqual(draw(["u1"]), [" ⏺ Read 1 file · 1 failed", " ⏺ Read(u1)"]);
  g.track({ role: "assistant", stopReason: "toolUse", content: [toolCall("u2")] });
  g.settle("u2", true, { content: [{ type: "text", text: "ENOENT" }] });
  g.track({ role: "user", content: "next" });
  g.track({ role: "assistant", stopReason: "aborted", content: [] });
  assert.deepEqual(draw(["u2"]), [" ⏺ Read 1 file · 1 failed", " ⏺ Read(u2)"]);
});

// #133: a run spans assistant messages until something drawn in the chat, or the end of the agent run.
const said = (...content) => ({ role: "assistant", stopReason: "toolUse", content });
const thinking = { type: "thinking", thinking: "hmm" };
/** A hidden-thinking session's groups. */
const groups = (t) => {
  const g = new td.ToolGroups();
  g.showThinking = false;
  t.after(() => g.reset());
  return g;
};

test("groups span tool-only messages; hidden thinking in any of them leads the summary; streaming updates are new objects", (t) => {
  const g = groups(t);
  g.track(said(toolCall("m1")));
  g.track(said(thinking), true); // the next message, streaming its thinking
  g.track(said(thinking, toolCall("m2")), true);
  g.track(said(thinking, toolCall("m2"), toolCall("m3")));
  g.track(said(toolCall("m4")));
  for (const id of ["m1", "m2", "m3", "m4"]) g.settle(id, false, { content: [] });
  g.endRun();
  assert.deepEqual(draw(["m1", "m2", "m3", "m4"]), [" ⏺ thought · read 4 files"]);
});

test("groups: a streaming message whose first call is revised out is still the same message", (t) => {
  const g = groups(t);
  g.track(said(toolCall("q0")));
  g.track(said(toolCall("q1"), toolCall("q2")), true);
  g.track(said(toolCall("q2")));
  for (const id of ["q0", "q2"]) g.settle(id, false, { content: [] });
  assert.deepEqual(draw(["q0", "q2"]), [" ⏺ Read 2 files"]);
  assert.deepEqual(draw(["q1"]), [" ⏺ Read(q1)"]); // no longer grouped
});

test("groups: a new message reusing an earlier message's call id is a new call", (t) => {
  const g = groups(t);
  g.track(said(toolCall("k1")));
  g.settle("k1", true, { content: [{ type: "text", text: "ENOENT" }] });
  g.track({ role: "user", content: "next" });
  g.track(said(toolCall("k2"), toolCall("k1"))); // ids made from the clock can repeat
  assert.deepEqual(draw(["k2", "k1"]), [" ⠋ Read 2 files"]); // the old call's failure is not the new one's
});

test("groups: text, a message drawn in the chat, a call without a summary, the end of an aborted message and the end of the agent run each split a run", (t) => {
  const g = groups(t);
  const steps = [
    [said(toolCall("p1"))],
    [said({ type: "text", text: "Next:" }, toolCall("p2"))], // text, drawn above its calls
    [{ role: "user", content: "steer" }, said(toolCall("p3"))],
    [{ role: "custom", display: true, content: "notice" }, said(toolCall("p4"))],
    [{ role: "custom", display: false, content: "hidden" }, { role: "system", content: "tools" }, said(toolCall("p5"))], // not drawn: joins p4
    [said(toolCall("p6", "ask_user"))],
    [said(toolCall("p7"))],
    [said(toolCall("p8")), "end", said(toolCall("p9"))],
    [{ ...said(toolCall("pa")), stopReason: "aborted" }, said(toolCall("pb"))], // pa joins p9; pb does not join pa
  ];
  for (const step of steps) for (const m of step) m === "end" ? g.endRun() : g.track(m);
  const grouped = ["p1", "p2", "p3", "p4", "p5", "p7", "p8", "p9", "pa", "pb"];
  for (const id of grouped) g.settle(id, false, { content: [] });
  draw(grouped); // p6 is drawn by its own tool
  const shown = grouped.map((id) => draw([id]).join());
  assert.deepEqual(shown, [" ⏺ Read 1 file", " ⏺ Read 1 file", " ⏺ Read 1 file", " ⏺ Read 2 files", "", " ⏺ Read 2 files", "", " ⏺ Read 2 files", "", " ⏺ Read 1 file"]);
});

test("groups: thinking Pi draws splits a group; hidden, it does not", (t) => {
  const g = groups(t);
  g.track(said(toolCall("h1")));
  g.track(said(thinking, toolCall("h2")));
  g.track(said(thinking)); // a message with only thinking
  g.track(said(toolCall("h3")));
  for (const id of ["h1", "h2", "h3"]) g.settle(id, false, { content: [] });
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ thought · read 3 files"]);
  td.thinkingShown(said(thinking, toolCall("h2")), true, true); // clicked open while thinking is hidden, reported by Pi's renderer
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ Read 1 file", " ⏺ thought · read 2 files"]);
  td.thinkingShown(said(thinking, toolCall("h3")), false, false); // Ctrl+T: the message with only thinking is drawn too
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ Read 1 file", " ⏺ thought · read 1 file", " ⏺ thought · read 1 file"]);
  td.thinkingShown(said(thinking, toolCall("h2")), false, true);
  td.thinkingShown(said(thinking, toolCall("h3")), false, true);
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ thought · read 3 files"]);
});

test("groups: a finished message with only thinking leads its run's summary with thought", (t) => {
  const g = groups(t);
  g.track(said(toolCall("o1")));
  g.settle("o1", false, { content: [] });
  assert.deepEqual(draw(["o1"]), [" ⏺ Read 1 file"]);
  g.track(said(thinking), true); // still streaming: it may yet call tools
  assert.deepEqual(draw(["o1"]), [" ⏺ Read 1 file"]);
  g.track({ ...said(thinking), stopReason: "stop" });
  assert.deepEqual(draw(["o1"]), [" ⏺ thought · read 1 file"]);
});

test("groups: a message that gains text after joining a run leaves it", (t) => {
  const g = groups(t);
  g.track(said(toolCall("j1")));
  g.track(said(toolCall("j2")), true);
  assert.deepEqual(draw(["j1", "j2"]), [" ⠋ Read 2 files"]);
  g.track(said(toolCall("j2"), { type: "text", text: "Done." }));
  assert.deepEqual(draw(["j1"]), [" ⠋ Read 1 file"]);
  assert.deepEqual(draw(["j2"]), [" ⠋ Read 1 file"]);
});

test("groups: a collapsed group's first call draws its failed calls, which draw nothing themselves", (t) => {
  const g = groups(t);
  g.track(said(toolCall("f1"), toolCall("f2"), toolCall("f3")));
  g.settle("f1", false, { content: [] });
  g.settle("f2", true, { content: [{ type: "text", text: "ENOENT /w/f2" }] });
  g.settle("f3", false, { content: [] });
  draw(["f1", "f2", "f3"]);
  assert.deepEqual(draw(["f1"]), [" ⏺ Read 3 files · 1 failed", " ⏺ Read(f2)", "   ⎿  Error: ENOENT f2"]);
  assert.deepEqual([draw(["f2"]), draw(["f3"])], [[], []]);
});
