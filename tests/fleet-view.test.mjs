// FleetView in a real pi (#44). The fleet extension and the test producer are
// loaded as two separate extensions, so every row on screen also shows that
// both see the one registry.
import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSIONS = [
  fileURLToPath(new URL("../extensions/fleet/index.ts", import.meta.url)),
  fileURLToPath(new URL("./fixtures/fleet/producer.ts", import.meta.url)),
];
const ROWS = 24;
const BORDER = "─".repeat(80);
const KEYS = " Enter to view · x to stop · ctrl+x ctrl+k to stop all agents"; // under the rows while FleetView has focus (#141)
const FOOTER = ["~/cwd", "0.0%/128k (auto)                                                       harness-1"];

// Regular mode before any prompt: blank header row, editor, FleetView, footer.
const idle = (fleet = [], editor = "") => pad(["", BORDER, editor, BORDER, ...fleet, ...FOOTER]);
// waitForScreen drops one leading newline, so a blank first row survives.
const pad = (lines) => "\n" + [...lines, ...Array(ROWS - lines.length).fill("")].join("\n");

async function start(t, options = {}) {
  const tui = await startTui(t, { extensions: EXTENSIONS, ...options });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  let n = 0;
  // Runs producer ops (tests/fixtures/fleet/producer.ts) and waits until they are applied.
  tui.fx = async (...ops) => {
    tui.type("/fx " + JSON.stringify(ops));
    tui.keys("Enter");
    await tui.waitForEvent("fx", ++n);
  };
  return tui;
}

test("rows show kind, label, running time and activity, nested under their parent", async (t) => {
  const tui = await start(t);
  await tui.waitForScreen(idle()); // empty registry: no FleetView

  await tui.fx(
    { add: "a", kind: "agent", label: "scout", activity: "reading src/a.ts" },
    { add: "b", kind: "shell", label: "npm test", parent: "a", activity: "PASS 3" },
    { add: "c", kind: "agent", label: "helper", parent: "a", activity: "thinking" },
    { clock: 65 },
  );
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · 1m05s",
    "    └─ reading src/a.ts",
    "     agent helper · 1m05s",
    "      └─ thinking",
    "   1 shell running in background",
  ]));

  await tui.fx({ act: "b", text: "PASS 4" }, { clock: 3725 });
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · 1h02m",
    "    └─ reading src/a.ts",
    "     agent helper · 1h02m",
    "      └─ thinking",
    "   1 shell running in background",
  ]));
});

async function waitForText(tui, text) {
  for (let i = 0; i < 100 && !tui.screen().includes(text); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(tui.screen().includes(text), `expected ${text} in screen:\n${tui.screen()}`);
}

test("running shells share one row; Enter lists only running shells and opens a log", async (t) => {
  const tui = await start(t, { args: ["--tui-mode", "fullscreen"] });
  await tui.fx(
    { add: "a", kind: "shell", label: "build" },
    { add: "b", kind: "shell", label: "lint" },
    { add: "c", kind: "shell", label: "old job" },
    { finish: "c", status: "failed", result: "exit 1" },
  );
  await waitForText(tui, "2 shells running in background");
  tui.keys("Down", "Down", "Enter");
  await waitForText(tui, "Running shells");
  assert.match(tui.screen(), /build · a/);
  assert.match(tui.screen(), /lint · b/);
  assert.doesNotMatch(tui.screen(), /old job/);
  tui.keys("Enter");
  await waitForText(tui, "shell build · 0s · esc back");
  await tui.fx({ finish: "a", status: "completed", result: "ok" });
  await waitForText(tui, "1 shell running in background");
  await tui.fx({ finish: "b", status: "completed", result: "ok" });
  assert.match(tui.screen(), /shell build · done 0s · esc back/); // log stays open after the last shell finishes
  assert.doesNotMatch(tui.screen(), /shells? running in background/);
  tui.keys("Escape");
  for (let i = 0; i < 100 && tui.screen().includes("shell build · done 0s · esc back"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.doesNotMatch(tui.screen(), /shell build · done 0s · esc back/);
});

test("the shell picker opens a log in regular mode", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "a", kind: "shell", label: "build" });
  await tui.waitForScreen(idle([" ● main", "   1 shell running in background"]));
  tui.keys("Down", "Down", "Enter");
  await waitForText(tui, "Running shells");
  tui.keys("Enter");
  await waitForText(tui, "shell build · 0s · esc back");
  tui.keys("Escape");
  await tui.waitForScreen(idle([" ● main", "   1 shell running in background"]));
});

test("x on the shell row lets you stop one running shell", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "a", kind: "shell", label: "build" }, { add: "b", kind: "shell", label: "lint" });
  await tui.waitForScreen(idle([" ● main", "   2 shells running in background"]));
  tui.keys("Down", "Down", "x");
  await waitForText(tui, "Stop running shell");
  tui.keys("Enter");
  await tui.waitForScreen(idle([" ● main", "›  1 shell running in background", KEYS]));
});

test("a click on an agent's activity line opens that agent", async (t) => {
  const tui = await start(t, { args: ["--tui-mode", "fullscreen"] });
  await tui.fx({ add: "a", kind: "agent", label: "scout", activity: "reading", transcript: "agent transcript" });
  await waitForText(tui, "└─ reading");
  const y = tui.screen().split("\n").findIndex((line) => line.includes("└─ reading")) + 1;
  assert.ok(y > 0);
  tui.click(10, y);
  for (let i = 0; i < 100 && !tui.screen().includes("agent scout · 0s · esc back"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(tui.screen(), /agent scout · 0s · esc back/);
});

test("control sequences are stripped from every row", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "sc\u001b]0;pwned\u0007out\u001b[2J", activity: "\u001b[31mred\u001b[0m\r\nnext\u0008" },
    { add: "b", kind: "shell", label: "tab\there", activity: "\u001b[?1049hwipe\u001bc\u009b2J\u001bP1$r\u001b\\" },
    { add: "c", kind: "monitor", label: "ci" },
    { finish: "c", status: "failed", result: "exit\u001b[1A 1\u0007" },
    // 8-bit OSC, ST and string introducers; BEL- and ST-terminated DCS, APC, PM and SOS.
    {
      add: "d",
      kind: "shell",
      label: "\u009d0;pwned\u0007eight\u009d8;;x\u009cbit",
      activity: "\u001bP1$r\u0007a\u001b_apc\u009cb\u009fapc\u001b\\c\u0090dcs\u0007d\u001b^pm\u0007e\u0098sos\u009cf",
    },
  );
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · 0s",
    "    └─ red next",
    "   monitor ci · failed 0s · exit 1",
    "   2 shells running in background",
  ]));
});

test("finished rows leave 10 s after they finish, without a prompt; a prompt does not remove them", async (t) => {
  const tui = await start(t, { replies: ["ok"] });
  await tui.fx(
    { add: "a", kind: "agent", label: "scout" },
    { add: "b", kind: "shell", label: "build" },
    { add: "c", kind: "monitor", label: "ci" },
    { clock: 5 },
    { finish: "a", status: "completed", result: "found 3 files" },
    { clock: 7 },
    { finish: "b", status: "stopped", result: "stopped by user" },
  );
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · done 5s",
    "    └─ found 3 files",
    "   monitor ci · 7s",
  ]));

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const chat = (fleet) => pad(["", " go", "", "", " ok", "", BORDER, "", BORDER, ...fleet, "~/cwd", "↑2 ↓1 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"]);
  await tui.waitForScreen(chat([
    " ● main",
    "   agent scout · done 5s",
    "    └─ found 3 files",
    "   monitor ci · 7s",
  ]));

  await tui.fx({ clock: 14.9 });
  await tui.waitForScreen(chat([
    " ● main",
    "   agent scout · done 5s",
    "    └─ found 3 files",
    "   monitor ci · 14s",
  ]));
  await tui.fx({ clock: 15 }); // 10 s after scout finished
  await tui.waitForScreen(chat([" ● main", "   monitor ci · 15s"]));
  await tui.fx({ clock: 17 });
  await tui.waitForScreen(chat([" ● main", "   monitor ci · 17s"]));
});

test("a selected finished row stays until the selection leaves it, then 10 s more", async (t) => {
  const tui = await start(t);
  const later = join(tui.home, "later");
  await tui.fx(
    { add: "a", kind: "agent", label: "build" },
    { add: "b", kind: "agent", label: "lint" },
    { finish: "a", status: "completed", result: "ok" },
    { finish: "b", status: "completed", result: "ok" },
    { clockWhen: later, clock: 100 },
  );
  tui.keys("Down", "Down", "Down"); // lint is selected; build, above it, is not
  await tui.waitForScreen(idle([" ● main", "   agent build · done 0s", "    └─ ok", "›  agent lint · done 0s", "    └─ ok", KEYS]));
  writeFileSync(later, "");
  await tui.waitForEvent("clock");
  const selected = idle([" ● main", "›  agent lint · done 0s", "    └─ ok", KEYS]);
  await tui.waitForScreen(selected); // build left; the selection stays on lint
  tui.keys("Escape"); // leaves it at 100 s
  const left = idle([" ● main", "   agent lint · done 0s", "    └─ ok"]);
  await tui.waitForScreen(left);
  await tui.fx({ clock: 109.9 });
  await tui.waitForScreen(left);
  await tui.fx({ clock: 110 });
  await tui.waitForScreen(idle());
});

test("a finished item stays finished when its producer updates it", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "scout" },
    { clock: 5 },
    { finish: "a", status: "completed", result: "found 3 files" },
    { clock: 9 },
    { update: "a", status: "running", label: "renamed" },
  );
  await tui.waitForScreen(idle([" ● main", "   agent scout · done 5s", "    └─ found 3 files"]));
});

test("an activity line that throws breaks only its own row", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "broken", throws: true, detail: ["kid-1"] },
    { add: "b", kind: "shell", label: "fine", activity: "PASS 3" },
  );
  await tui.waitForScreen(idle([" ● main", "   agent broken · 0s · detail failed", "    └─ activity failed", "   1 shell running in background"]));
});

test("detail fields follow the status and drop from the right when the row is narrow; the label and status stay", async (t) => {
  const detail = ["claude-sonnet-4-5", "high", "41.2k tokens", "$0.31", "12 turns", "34 tool uses"];
  const ops = [
    { add: "a", kind: "agent", label: "scout", activity: "reading", detail },
    { add: "b", kind: "agent", label: "a-very-long-agent-label-that-fills-the-row", detail },
    { add: "c", kind: "shell", label: "test", detail: ["npm"], activity: "PASS src/a.test.ts, src/b.test.ts, src/c.test.ts and more" },
    { clock: 133 },
    { finish: "a", status: "completed", result: "STATUS: DONE" },
  ];
  const wide = await start(t);
  await wide.fx(...ops);
  await wide.waitForScreen(idle([
    " ● main",
    "   agent scout · done 2m13s · claude-sonnet-4-5 · high · 41.2k tokens · $0.31",
    "    └─ STATUS: DONE",
    "   agent a-very-long-agent-label-that-fills-the-row · 2m13s · claude-sonnet-4-5",
    "   1 shell running in background",
  ]));

  const narrow = await start(t, { cols: 60 });
  await narrow.fx(...ops);
  const border = "─".repeat(60);
  await narrow.waitForScreen(pad([
    "", border, "", border,
    " ● main",
    "   agent scout · done 2m13s · claude-sonnet-4-5 · high",
    "    └─ STATUS: DONE",
    "   agent a-very-long-agent-label-that-fills-the-row · 2m13s",
    "   1 shell running in background",
    "~/cwd",
    "0.0%/128k (auto)                                   harness-1",
  ]));
});

test("arrow keys at an empty prompt move through FleetView and past either end; Esc returns", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "a", kind: "agent", label: "one" }, { add: "b", kind: "shell", label: "two" });
  const screen = (marks, editor = "") =>
    idle([`${marks[0]}● main`, `${marks[1]}  agent one · 0s`, `${marks[2]}  1 shell running in background`, ...(marks.trim() ? [KEYS] : [])], editor);
  await tui.waitForScreen(screen("   "));

  tui.keys("Down");
  await tui.waitForScreen(screen("›  "));
  tui.keys("Down");
  await tui.waitForScreen(screen(" › "));
  tui.keys("Down");
  await tui.waitForScreen(screen("  ›"));
  tui.keys("Down"); // past the last row: back to the editor
  await tui.waitForScreen(screen("   "));

  tui.keys("Down"); // re-enter: empty editor, so Down focuses main again
  await tui.waitForScreen(screen("›  "));
  tui.keys("Up"); // past the first row: back to the editor
  await tui.waitForScreen(screen("   "));
  tui.keys("Escape"); // already out: nothing happens
  await tui.waitForScreen(screen("   "));

  tui.keys("Left");
  await tui.waitForScreen(screen("›  "));
  tui.keys("Escape");
  await tui.waitForScreen(screen("   "));

  // With text in the prompt the arrows edit it and FleetView stays unfocused.
  tui.type("hi");
  tui.keys("Left", "Down", "Left");
  tui.type("X");
  await tui.waitForScreen(screen("   ", "hXi"));
});

test("rows stay within the line budget and scroll to the selection", async (t) => {
  const tui = await start(t);
  const labels = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  await tui.fx(...labels.map((l) => ({ add: l, kind: "agent", label: l })));
  const row = (label, sel) => `${sel ? "›" : " "}  agent ${label} · 0s`;
  // Focused, the keys line takes one of the 6 lines.
  const view = (first, sel) => {
    const all = [`${sel === 0 ? "›" : " "}● main`, ...labels.map((l, i) => row(l, sel === i + 1))];
    const size = sel === undefined ? 5 : 4;
    return idle([...all.slice(first, first + size), `   … ${9 - size} more`, ...(sel === undefined ? [] : [KEYS])]);
  };
  await tui.waitForScreen(view(0));

  tui.keys("Down"); // focus main
  tui.keys("Down", "Down", "Down", "Down", "Down", "Down");
  await tui.waitForScreen(view(3, 6));
  tui.keys("Down", "Down");
  await tui.waitForScreen(view(5, 8));
  tui.keys(...Array(8).fill("Up"));
  await tui.waitForScreen(view(0, 0));
});

test("scrolling keeps each agent's activity with its selectable row", async (t) => {
  const tui = await start(t);
  await tui.fx(...["a1", "a2", "a3", "a4"].map((id) => ({ add: id, kind: "agent", label: id, activity: "working" })));
  await tui.waitForScreen(idle([
    " ● main", "   agent a1 · 0s", "    └─ working", "   agent a2 · 0s", "    └─ working", "   … 2 more",
  ]));
  tui.keys("Down", "Down", "Down"); // second agent, below the focused viewport
  await tui.waitForScreen(idle([
    "   agent a1 · 0s", "    └─ working", "›  agent a2 · 0s", "    └─ working", "   … 3 more", KEYS,
  ]));
});

test("notices are one compact themed line; a failure shows its error", async (t) => {
  const tui = await start(t, { replies: ["noted", "noted too"] });
  await tui.fx(
    { add: "a", kind: "agent", label: "scout" },
    { add: "b", kind: "shell", label: "npm test" },
    { add: "c", kind: "monitor", label: "ci watch" },
    { clock: 5 },
    { finish: "a", status: "completed", result: "found 3 files\nsecond line", notice: "agent scout completed" },
    { clock: 7 },
    { finish: "b", status: "failed", result: "exit 1\nError: boom", notice: "shell npm test failed: exit 1" },
    { notify: "c", text: "build 42 passed" },
  );
  // One run: pi's one-at-a-time steering takes the third notice at the next step.
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(pad([
    "",
    " ✓ agent scout · done 5s · found 3 files",
    "",
    " ✗ shell npm test · failed 7s",
    "   exit 1",
    "   Error: boom",
    "",
    " noted",
    "",
    " ● monitor ci watch · 7s · build 42 passed",
    "",
    " noted too",
    "",
    BORDER,
    "",
    BORDER,
    " ● main",
    "   agent scout · done 5s",
    "    └─ found 3 files second line",
    "   monitor ci watch · 7s",
    "~/cwd",
    "↑26 ↓5 R16 W26 CH44.4% 0.0%/128k (auto)                                harness-1",
  ]));
});

test("x stops the selected running or queued row at once; on a finished row or main it does nothing", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "build" },
    { add: "b", kind: "monitor", label: "ci", status: "queued" },
    { add: "c", kind: "agent", label: "scout" },
    { finish: "c", status: "completed", result: "" },
  );
  const rows = (marks, a = "0s", b = "queued") =>
    idle([`${marks[0]}● main`, `${marks[1]}  agent build · ${a.split(" · ")[0]}`, ...(a.startsWith("stopped") ? ["    └─ stopped by user"] : []), `${marks[2]}  monitor ci · ${b}`, `${marks[3]}  agent scout · done 0s`, KEYS]);
  tui.keys("Down", "x"); // main: nothing to stop, and x is not typed into the editor
  await tui.waitForScreen(rows("›   "));
  tui.keys("Down", "x");
  await tui.waitForScreen(rows(" ›  ", "stopped 0s · stopped by user"));
  tui.keys("Down", "x");
  await tui.waitForScreen(rows("  › ", "stopped 0s · stopped by user", "stopped 0s · stopped by user"));
  tui.keys("Down", "x", "Up"); // finished: x leaves its result alone
  await tui.waitForScreen(rows("  › ", "stopped 0s · stopped by user", "stopped 0s · stopped by user"));
  tui.keys("Down");
  await tui.waitForScreen(rows("   ›", "stopped 0s · stopped by user", "stopped 0s · stopped by user"));
});

test("Ctrl+X Ctrl+K in FleetView stops every running or queued agent and leaves jobs alone", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "scout" },
    { add: "b", kind: "shell", label: "build" },
  );
  tui.keys("Down", "C-x", "C-k");
  await tui.waitForScreen(idle([
    "›● main",
    "   agent scout · stopped 0s",
    "    └─ stopped by user",
    "   1 shell running in background",
    KEYS,
  ]));
});

test("Ctrl+K without Ctrl+X stops nothing", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "a", kind: "agent", label: "scout" });
  tui.keys("Down", "C-k", "Down"); // in FleetView, Ctrl+K alone is not the chord: it returns to the editor
  await tui.waitForScreen(idle(["›● main", "   agent scout · 0s", KEYS]));
});

for (const cols of [30, 60]) {
  test(`at ${cols} columns a long label is shortened so the status stays, and a dropped field drops everything to its right`, async (t) => {
    const tui = await start(t, { cols });
    await tui.fx(
      { add: "a", kind: "agent", label: "a-very-long-agent-label-that-fills-the-row-and-more", activity: "reading", detail: ["kid-1", "low"] },
      { add: "b", kind: "shell", label: "test", activity: "PASS", detail: ["a-detail-field-far-too-wide-for-this-row-to-hold"] },
      { clock: 133 },
    );
    const border = "─".repeat(cols);
    const footer = "0.0%/128k (auto)".padEnd(cols - "harness-1".length) + "harness-1";
    await tui.waitForScreen(pad(["", border, "", border, " ● main", ...ROWS_AT[cols], "~/cwd", footer]));
  });
}
const ROWS_AT = {
  30: ["   agent a-very-long-… · 2m13s", "    └─ reading", "   1 shell running in backg..."],
  60: ["   agent a-very-long-agent-label-that-fills-the-row… · 2m13s", "    └─ reading", "   1 shell running in background"],
};

