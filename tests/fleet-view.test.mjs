// FleetView in a real pi (#44). The fleet extension and the test producer are
// loaded as two separate extensions, so every row on screen also shows that
// both see the one registry.
import { test } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSIONS = [
  fileURLToPath(new URL("../extensions/fleet/index.ts", import.meta.url)),
  fileURLToPath(new URL("./fixtures/fleet/producer.ts", import.meta.url)),
];
const ROWS = 24;
const BORDER = "─".repeat(80);
const FOOTER = ["~/cwd", "0.0%/128k (auto)                                                       harness-1"];

// Regular mode before any prompt: blank header row, editor, FleetView, footer.
const idle = (fleet = [], editor = "") => pad(["", BORDER, editor, BORDER, ...fleet, ...FOOTER]);
// Fullscreen mode: the same block pinned to the bottom.
const fullscreen = (fleet = []) => {
  const block = [BORDER, "", BORDER, ...fleet, ...FOOTER];
  return "\n" + [...Array(ROWS - block.length).fill(""), ...block].join("\n");
};
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
    { add: "c", kind: "agent", label: "helper", parent: "b", activity: "thinking" },
    { add: "d", kind: "monitor", label: "ci watch", status: "queued" },
    { clock: 65 },
  );
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · 1m05s · reading src/a.ts",
    "     shell npm test · 1m05s · PASS 3",
    "       agent helper · 1m05s · thinking",
    "   monitor ci watch · queued",
  ]));

  await tui.fx({ act: "b", text: "PASS 4" }, { clock: 3725 });
  await tui.waitForScreen(idle([
    " ● main",
    "   agent scout · 1h02m · reading src/a.ts",
    "     shell npm test · 1h02m · PASS 4",
    "       agent helper · 1h02m · thinking",
    "   monitor ci watch · queued",
  ]));
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
    "   agent scout · 0s · red next",
    "   shell tab here · 0s · wipe",
    "   monitor ci · failed 0s · exit 1",
    "   shell eightbit · 0s · abcdef",
  ]));
});

test("finished items stay until the next user prompt", async (t) => {
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
  const withFinished = idle([
    " ● main",
    "   agent scout · done 5s · found 3 files",
    "   shell build · stopped 7s · stopped by user",
    "   monitor ci · 7s",
  ]);
  await tui.waitForScreen(withFinished);
  await tui.fx({ clock: 9 }); // a command is not a prompt
  await tui.waitForScreen(withFinished.replace("ci · 7s", "ci · 9s"));

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(pad([
    "",
    " go",
    "",
    "",
    " ok",
    "",
    BORDER,
    "",
    BORDER,
    " ● main",
    "   monitor ci · 9s",
    "~/cwd",
    "↑2 ↓1 W2 CH0.0% 0.0%/128k (auto)                                       harness-1",
  ]));
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
  await tui.waitForScreen(idle([" ● main", "   agent scout · done 5s · found 3 files"]));
});

test("an activity line that throws breaks only its own row", async (t) => {
  const tui = await start(t);
  await tui.fx(
    { add: "a", kind: "agent", label: "broken", throws: true },
    { add: "b", kind: "shell", label: "fine", activity: "PASS 3" },
  );
  await tui.waitForScreen(idle([" ● main", "   agent broken · 0s · activity failed", "   shell fine · 0s · PASS 3"]));
});

test("arrow keys at an empty prompt move through FleetView; Esc returns", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "a", kind: "agent", label: "one" }, { add: "b", kind: "shell", label: "two" });
  const screen = (marks, editor = "") =>
    idle([`${marks[0]}● main`, `${marks[1]}  agent one · 0s`, `${marks[2]}  shell two · 0s`], editor);
  await tui.waitForScreen(screen("   "));

  tui.keys("Down");
  await tui.waitForScreen(screen("›  "));
  tui.keys("Down");
  await tui.waitForScreen(screen(" › "));
  tui.keys("Down", "Down"); // stops at the last row
  await tui.waitForScreen(screen("  ›"));
  tui.keys("Up");
  await tui.waitForScreen(screen(" › "));
  tui.keys("Escape");
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
  await tui.fx(...labels.map((l) => ({ add: l, kind: "shell", label: l })));
  const row = (label, sel) => `${sel ? "›" : " "}  shell ${label} · 0s`;
  const view = (first, sel) => {
    const all = [`${sel === 0 ? "›" : " "}● main`, ...labels.map((l, i) => row(l, sel === i + 1))];
    return idle([...all.slice(first, first + 5), "   … 4 more"]);
  };
  await tui.waitForScreen(view(0));

  tui.keys("Down"); // focus main
  tui.keys("Down", "Down", "Down", "Down", "Down", "Down");
  await tui.waitForScreen(view(2, 6));
  tui.keys("Down", "Down");
  await tui.waitForScreen(view(4, 8));
  tui.keys(...Array(8).fill("Up"));
  await tui.waitForScreen(view(0, 0));
});

test("in fullscreen mode a click selects a row", async (t) => {
  const tui = await start(t, { args: ["--tui-mode", "fullscreen"] });
  await tui.fx({ add: "a", kind: "agent", label: "one" }, { add: "b", kind: "shell", label: "two" });
  const screen = (marks) => fullscreen([`${marks[0]}● main`, `${marks[1]}  agent one · 0s`, `${marks[2]}  shell two · 0s`]);
  await tui.waitForScreen(screen("   "));

  tui.click(10, 22);
  await tui.waitForScreen(screen("  ›"));
  tui.click(3, 20);
  await tui.waitForScreen(screen("›  "));
  tui.keys("Escape");
  await tui.waitForScreen(screen("   "));
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
    "   agent scout · done 5s · found 3 files second line",
    "   shell npm test · failed 7s · exit 1 Error: boom",
    "   monitor ci watch · 7s",
    "~/cwd",
    "↑26 ↓5 R16 W26 CH44.4% 0.0%/128k (auto)                                harness-1",
  ]));
});
