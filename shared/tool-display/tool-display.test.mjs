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

test("group summary: failed and cancelled calls are not counted as done work and show in the error colour", () => {
  const theme = recordingTheme();
  const calls = [
    { summary: READ, status: "done" },
    { summary: READ, status: "done" },
    { summary: EDIT, status: "error", args: { lines: { added: 5, removed: 5 } } },
    { summary: READ, status: "cancelled" },
    { summary: BASH, status: "cancelled" },
  ];
  const text = td.summaryText(theme, calls);
  assert.equal(plain(text), "Read 2 files · 1 failed · 2 cancelled");
  assert.match(text, /\x1b\[38;5;\d+m1 failed/);
  assert.equal(theme.keys.at(-1), "error");
  assert.equal(theme.keys.at(-2), "error");
  assert.equal(plain(td.summaryText(recordingTheme(), [{ summary: READ, status: "cancelled" }])), "1 cancelled");
});
