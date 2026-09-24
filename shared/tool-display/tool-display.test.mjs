import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../tests/fixtures/tool-display/pi-tui.mjs";

const td = await import("./index.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

// Pending grouped calls show at once here; the grace period has its own tests below.
td.ToolGroups.defaultGraceMs = 0;

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

test("group summary: failed and cancelled calls count under their verb without drawing alerts", () => {
  const theme = recordingTheme();
  const calls = [
    { summary: READ, status: "done" },
    { summary: READ, status: "done" },
    { summary: EDIT, status: "error", args: { lines: { added: 5, removed: 5 } } },
    { summary: READ, status: "cancelled" },
    { summary: BASH, status: "cancelled" },
  ];
  const text = td.summaryText(theme, calls);
  assert.equal(plain(text), "Read 3 files, edited 1 file, ran 1 shell command");
  assert.ok(!theme.keys.includes("error"));
  assert.equal(plain(td.summaryText(recordingTheme(), [{ summary: READ, status: "error" }])), "Read 1 file");
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
  assert.deepEqual(draw(["v1"]), [" ⏺ Read 1 file"]);
  assert.deepEqual(draw(["v2"]), [" ⏺ Read(v2)"]); // no longer grouped
});

test("groups: a call with an image stays folded; Pi draws the image itself", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", content: [toolCall("i1"), toolCall("i2")] });
  draw(["i1", "i2"]);
  g.settle("i1", false, { content: [] });
  g.settle("i2", false, { content: [{ type: "image", data: "", mimeType: "image/png" }] });
  assert.deepEqual(draw(["i1", "i2"]), [" ⏺ Read 2 files"]);
});

test("groups: an aborted message cancels its calls with no result; an errored one fails them", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", stopReason: "aborted", content: [toolCall("a1"), toolCall("a2")] });
  g.track({ role: "assistant", stopReason: "error", content: [toolCall("f1")] });
  g.settle("a1", false, { content: [] });
  assert.deepEqual(draw(["a1", "a2"]), [" ⏺ Read 2 files"]);
  assert.deepEqual(draw(["f1"]), [" ⏺ Read 1 file"]);
});

test("a failed collapsed group has a neutral dot and no error colour", (t) => {
  const g = new td.ToolGroups();
  t.after(() => g.reset());
  g.track({ role: "assistant", content: [toolCall("neutral")] });
  g.settle("neutral", true, { content: [{ type: "text", text: "ENOENT" }] });
  g.endRun();
  const theme = recordingTheme();
  const render = () => GROUPED.renderCall({ path: "neutral" }, theme, { toolCallId: "neutral", args: {}, cwd: "/w", expanded: false, invalidate() {} });
  assert.deepEqual(plainLines(render().render(80)), [" ⏺ Read 1 file"]);
  assert.equal(theme.keys[0], "muted");
  assert.ok(!theme.keys.includes("error"));
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
  assert.deepEqual(draw(["u1"]), [" ⏺ Read 1 file"]);
  g.track({ role: "assistant", stopReason: "toolUse", content: [toolCall("u2")] });
  g.settle("u2", true, { content: [{ type: "text", text: "ENOENT" }] });
  g.track({ role: "user", content: "next" });
  g.track({ role: "assistant", stopReason: "aborted", content: [] });
  assert.deepEqual(draw(["u2"]), [" ⏺ Read 1 file"]);
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
  assert.deepEqual(draw(["k2", "k1"]), [" ⏺ Read 2 files"]); // the old call's failure is not the new one's
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
  assert.deepEqual(draw(["j1", "j2"]), [" ⏺ Read 2 files"]);
  g.track(said(toolCall("j2"), { type: "text", text: "Done." }));
  assert.deepEqual(draw(["j1"]), [" ⏺ Read 1 file"]);
  assert.deepEqual(draw(["j2"]), [" ⏺ Read 1 file"]);
});

test("groups: a collapsed group's failed calls stay folded under the summary", (t) => {
  const g = groups(t);
  g.track(said(toolCall("f1"), toolCall("f2"), toolCall("f3")));
  g.settle("f1", false, { content: [] });
  g.settle("f2", true, { content: [{ type: "text", text: "ENOENT /w/f2" }] });
  g.settle("f3", false, { content: [] });
  draw(["f1", "f2", "f3"]);
  assert.deepEqual(draw(["f1"]), [" ⏺ Read 3 files"]);
  assert.deepEqual([draw(["f2"]), draw(["f3"])], [[], []]);
});

// #139: a running call with a hint shows outside its group until the hint is cleared.
const HINT = () => "ctrl+b to run in background";
const hinted = (t, owner = "s") => {
  const g = groups(t);
  g.owner = owner;
  return g;
};

test("hints: a hinted call after the first shows outside the summary with its hint, and folds back when cleared", (t) => {
  const g = hinted(t);
  g.track(said(toolCall("h1"), toolCall("h2"), toolCall("h3")));
  g.settle("h1", false, { content: [] });
  draw(["h1", "h2", "h3"]);
  const clear = td.showHint("s", "h2", HINT);
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ Read 3 files", " ⏺ Read(h2)", "   ⎿  ctrl+b to run in background"]);
  clear();
  assert.deepEqual(draw(["h1", "h2", "h3"]), [" ⏺ Read 3 files"]);
});

test("hints: a failed call stays folded while the group's first call is hinted", (t) => {
  const g = hinted(t);
  g.track(said(toolCall("l1"), toolCall("l2")));
  g.settle("l2", true, { content: [{ type: "text", text: "ENOENT /w/l2" }] });
  draw(["l1", "l2"]);
  td.showHint("s", "l1", HINT);
  assert.deepEqual(draw(["l1", "l2"]), [" ⏺ Read 2 files", " ⏺ Read(l1)", "   ⎿  ctrl+b to run in background"]);
});

test("hints: read on every draw; while the hint returns nothing the call stays folded", (t) => {
  const g = hinted(t);
  g.track(said(toolCall("r1")));
  let text;
  td.showHint("s", "r1", () => text);
  assert.deepEqual(draw(["r1"]), [" ⏺ Read 1 file"]);
  text = "hint";
  assert.deepEqual(draw(["r1"]), [" ⏺ Read 1 file", " ⏺ Read(r1)", "   ⎿  hint"]);
});

test("hints: two sessions with the same call id never share a hint or clear each other's", (t) => {
  const a = hinted(t, "a");
  const b = hinted(t, "b");
  const inA = toolCall("dup");
  const inB = toolCall("dup");
  a.track(said(inA));
  b.track(said(inB));
  // Each session's call, drawn with its own arguments (how a renderer finds its session).
  const drawIn = (call) => {
    const render = () => GROUPED.renderCall(call.arguments, recordingTheme(), { toolCallId: "dup", args: call.arguments, cwd: "/w", expanded: false, invalidate() {} });
    render();
    return plainLines(render().render(80));
  };
  const clearA = td.showHint("a", "dup", HINT);
  td.showHint("b", "dup", () => "b's hint");
  clearA();
  assert.deepEqual(drawIn(inA), [" ⏺ Read 1 file"]);
  assert.deepEqual(drawIn(inB), [" ⏺ Read 1 file", " ⏺ Read(dup)", "   ⎿  b's hint"]);
});

test("hints: a hint redraws its call, and only this session's hinted calls", (t) => {
  const a = hinted(t, "a");
  const b = hinted(t, "b");
  a.track(said(toolCall("k1")));
  b.track(said(toolCall("k2")));
  const counts = { k1: 0, k2: 0 };
  for (const id of ["k1", "k2"]) GROUPED.renderCall({ path: id }, recordingTheme(), { toolCallId: id, args: {}, cwd: "/w", expanded: false, invalidate: () => counts[id]++ });
  // No tool-row spinner is left, so the hint itself (not a tick) triggers the redraw.
  td.showHint("a", "k1", HINT);
  assert.deepEqual(counts, { k1: 1, k2: 0 });
  td.showHint("b", "k2", HINT);
  assert.deepEqual(counts, { k1: 1, k2: 1 });
});

test("groups: a shell execution folds into the run around it instead of splitting it", (t) => {
  const g = groups(t);
  g.track(said(toolCall("e1")));
  g.track({ role: "bashExecution", command: "echo hi", output: "hi" });
  g.track(said(toolCall("e2")));
  for (const id of ["e1", "e2"]) g.settle(id, false, { content: [] });
  g.endRun();
  assert.deepEqual(draw(["e1", "e2"]), [" ⏺ Read 2 files"]);
});

test("groups: a fresh pending group draws nothing; settling or outlasting the grace period shows it", (t) => {
  const g = groups(t);
  g.graceMs = 60_000;
  g.track(said(toolCall("w1"), toolCall("w2")));
  assert.deepEqual(draw(["w1", "w2"]), [], "fresh pending calls never flash");
  g.settle("w1", false, { content: [] });
  assert.deepEqual(draw(["w1", "w2"]), [" ⏺ Read 2 files"], "a settled call shows at once");
  g.graceMs = 0;
  const h = groups(t);
  h.graceMs = 60_000;
  h.track(said(toolCall("w3")));
  assert.deepEqual(draw(["w3"]), []);
  h.graceMs = 0;
  assert.deepEqual(draw(["w3"]), [" ⏺ Read 1 file"], "a call past its grace period shows");
});

test("hints: a hinted call shows at once, inside the grace period", (t) => {
  const g = hinted(t);
  g.graceMs = 60_000;
  g.track(said(toolCall("g1"), toolCall("g2")));
  assert.deepEqual(draw(["g1", "g2"]), []);
  td.showHint("s", "g2", HINT);
  assert.deepEqual(draw(["g1", "g2"]), [" ⏺ Read 2 files", " ⏺ Read(g2)", "   ⎿  ctrl+b to run in background"]);
});

test("streamed text seals the open run once and redraws only its calls", (t) => {
  const g = groups(t);
  const ids = [];
  for (let m = 0; m < 10; m++) {
    const calls = [toolCall(`s${m}a`), toolCall(`s${m}b`)];
    g.track(said({ type: "text", text: `step ${m}` }, ...calls));
    ids.push(...calls.map((c) => c.id));
  }
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const id of ids) GROUPED.renderCall({ path: id }, recordingTheme(), { toolCallId: id, args: {}, cwd: "/w", expanded: false, invalidate: () => counts[id]++ });
  for (const id of ids) counts[id] = 0; // a call joining its group redraws the one before
  let text = "";
  for (let i = 0; i < 20; i++) g.track({ role: "assistant", content: [{ type: "text", text: (text += `t${i} `) }] }, true);
  // The last message's run is sealed by the first token; earlier runs were sealed already.
  assert.deepEqual(counts, { ...Object.fromEntries(ids.map((id) => [id, 0])), s9a: 1, s9b: 1 });
});

test("a redrawn call's components never keep earlier render contexts alive", async (t) => {
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const g = groups(t);
  g.track(said(toolCall("lk1"), toolCall("lk2")));
  g.settle("lk1", true, { content: [{ type: "text", text: "boom" }] });
  // Pi hands each redraw the previous component as `lastComponent`.
  const redraw = (id, n) => {
    let last, first;
    for (let i = 0; i < n; i++) {
      const context = { toolCallId: id, args: {}, cwd: "/w", expanded: false, isError: false, invalidate() {}, lastComponent: last };
      first ??= new WeakRef(context);
      last = GROUPED.renderCall({ path: id }, recordingTheme(), context);
      last = { call: last, result: GROUPED.renderResult({ content: [] }, { expanded: true, isPartial: false }, recordingTheme(), { ...context, expanded: true }) };
    }
    return { first, last };
  };
  const held = ["lk1", "lk2"].map((id) => redraw(id, 5));
  await new Promise((r) => setImmediate(r)); // WeakRefs clear only after the current job
  gc();
  assert.deepEqual(held.map(({ first }) => first.deref()), [undefined, undefined]);
  assert.ok(held.every(({ last }) => last.call.render(80)));
});
