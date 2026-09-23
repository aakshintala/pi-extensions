// The viewer frame in a real pi (#45): the chat-area swap, its overlay fallback,
// log follow and pause, stop with confirmation, steer, and releasing watchers.
import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const EXTENSIONS = [
  fileURLToPath(new URL("../extensions/fleet/index.ts", import.meta.url)),
  fileURLToPath(new URL("./fixtures/fleet/producer.ts", import.meta.url)),
];
const ROWS = 24;
const BORDER = "─".repeat(80);
const FOOTER = ["~/cwd", "0.0%/128k (auto)                                                       harness-1"];

// Fullscreen mode: the chat area on top, the editor, FleetView and footer pinned to the bottom.
const screen = (chat, fleet, { editor = "", footer = FOOTER, above = [], border = BORDER } = {}) => {
  const dock = [...above, border, ...[editor].flat(), BORDER, ...fleet, ...footer];
  const top = [...chat, ...Array(ROWS - dock.length - chat.length).fill("")];
  return "\n" + [...top, ...dock].join("\n");
};
// FleetView rows for items a (shell build) and b (agent scout); `on` is the row on screen.
const rows = (on, extra = {}) => [
  ` ${on === "main" ? "●" : " "} main`,
  ` ${on === "a" ? "●" : " "} shell build · ${extra.a ?? "0s"}`,
  ` ${on === "b" ? "●" : " "} agent scout · ${extra.b ?? "0s"}`,
];
const logView = (lines) => [" shell build · 0s · esc back · ctrl+q stop", ...lines.map((l) => ` ${l}`)];
const agentView = (lines, state = "0s") => [` agent scout · ${state} · esc back · ctrl+q stop · enter steers`, " agent transcript", ...lines];

async function start(t, { lines = ["one", "two", "three"], fullscreen = true, extensions = EXTENSIONS, before, ...options } = {}) {
  const tui = await startTui(t, { extensions, args: fullscreen ? ["--tui-mode", "fullscreen"] : [], ...options });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  let n = 0;
  tui.fx = async (...ops) => {
    tui.type("/fx " + JSON.stringify(ops));
    tui.keys("Enter");
    await tui.waitForEvent("fx", ++n);
  };
  tui.log = join(tui.home, "build.log");
  writeFileSync(tui.log, lines.map((l) => l + "\n").join(""));
  tui.watchers = async (count) => {
    await tui.fx({ watchers: true });
    assert.equal(tui.events().filter((e) => e.startsWith("watchers:")).at(-1), `watchers:${count}`);
  };
  await before?.(tui);
  await tui.fx(
    { add: "a", kind: "shell", label: "build", log: tui.log },
    { add: "b", kind: "agent", label: "scout", transcript: "agent transcript", steer: true },
  );
  return tui;
}

test("Enter opens an item in place of the chat; another item switches straight to it; main and Esc return", async (t) => {
  const tui = await start(t);
  const main = screen([], rows("main"));
  await tui.waitForScreen(main);

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), rows("a")));

  tui.keys("Down", "Down", "Down", "Enter"); // from the log straight to the agent
  await tui.waitForScreen(screen(agentView([]), rows("b")));

  tui.keys("Down", "Enter"); // the main row
  await tui.waitForScreen(main);

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), rows("a")));
  tui.keys("Escape");
  await tui.waitForScreen(main);
});

test("a click on a FleetView row opens it", async (t) => {
  const tui = await start(t);
  await tui.waitForScreen(screen([], rows("main")));
  tui.click(10, 22); // agent scout
  await tui.waitForScreen(screen(agentView([]), rows("b")));
  tui.click(10, 20); // main
  await tui.waitForScreen(screen([], rows("main")));
});

test("main-session output while a viewer is open lands in the main chat", async (t) => {
  const tui = await start(t, { replies: ["noted"] });
  tui.keys("Down", "Down", "Enter");
  const viewing = (footer) => screen(logView(["one", "two", "three"]), rows("a"), { footer });
  await tui.waitForScreen(viewing(FOOTER));

  await tui.fx({ notify: "a", text: "build 42 passed" }); // starts a main turn
  await tui.waitForEvent("agent_end");
  const footer = ["~/cwd", "↑5 ↓2 W5 CH0.0% 0.0%/128k (auto)                                       harness-1"];
  await tui.waitForScreen(viewing(footer));

  tui.keys("Escape");
  await tui.waitForScreen(screen(["", " ● shell build · 0s · build 42 passed", "", " noted"], rows("main"), { footer }));
});

test("a log viewer follows new output, pauses when scrolled up, and End jumps back", async (t) => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const tui = await start(t, { lines });
  // Finished items: no running-time timer redraws the screen, so only the log watcher does.
  await tui.fx({ finish: "a", status: "completed", result: "ok" }, { finish: "b", status: "completed", result: "ok" });
  const done = [" ● main", "   shell build · done 0s · ok", "   agent scout · done 0s · ok"];
  await tui.waitForScreen(screen([], done));
  tui.keys("Down", "Down", "Enter");
  const fleet = [...done.map((r) => r.replace(" ●", "  ")).slice(0, 1), " ● shell build · done 0s · ok", done[2]];
  // The rows above the dock, the last one blank: the header and the first lines scrolled away.
  const tail = (all, rows = fleet) => screen([...all.slice(-(ROWS - 6 - rows.length)).map((l) => ` ${l}`), ""], rows);
  await tui.waitForScreen(tail(lines));

  // Control sequences are stripped; colours are kept (not visible in the capture).
  appendFileSync(tui.log, "line 21 \x1b[31mred\x1b[0m\x1b]0;pwned\x07\x1b[2J\n");
  const followed = [...lines, "line 21 red"];
  await tui.waitForScreen(tail(followed));

  // Pi's transcript scroll view: scrolled up, the view stays put while output arrives.
  tui.keys("PageUp");
  const top = [" shell build · done 0s · esc back · ctrl+q stop", ...lines.slice(0, 13).map((l) => ` ${l}`)];
  const paused = screen([...top, " line 14                 ↓ Jump to latest message · End", ""], fleet);
  await tui.waitForScreen(paused);
  appendFileSync(tui.log, "line 22\n");
  // A new row redraws the screen, and each redraw reads the log first.
  await tui.fx({ add: "c", kind: "monitor", label: "tick", status: "queued" });
  const withC = [...fleet, "   monitor tick · queued"];
  // FleetView grew by a row, so the view is one row shorter; it still starts at the top.
  await tui.waitForScreen(screen([...top.slice(0, -1), " line 13                 ↓ Jump to latest message · End", ""], withC));

  tui.keys("End");
  await tui.waitForScreen(tail([...followed, "line 22"], withC));

  // Reopened after leaving it scrolled up, the viewer follows the end again.
  tui.keys("PageUp");
  await tui.waitForScreen(screen([...top.slice(0, -1), " line 13                 ↓ Jump to latest message · End", ""], withC));
  tui.keys("Escape", "Down", "Down", "Enter");
  await tui.waitForScreen(tail([...followed, "line 22"], withC));
});

test("stop asks for confirmation first", async (t) => {
  const tui = await start(t);
  tui.keys("Down", "Down", "Down", "Enter");
  await tui.waitForScreen(screen(agentView([]), rows("b")));

  tui.keys("C-q");
  const asking = [...rows("b"), " Stop agent scout? y stops it, any other key cancels."];
  await tui.waitForScreen(screen(agentView([]), asking));
  tui.type("n"); // cancels, and is not typed into the editor
  await tui.waitForScreen(screen(agentView([]), rows("b")));

  tui.keys("C-q");
  await tui.waitForScreen(screen(agentView([]), asking));
  tui.type("y");
  // The viewer stays open on the stopped item.
  await tui.waitForScreen(screen(agentView([], "stopped 0s"), rows("b", { b: "stopped 0s · stopped by user" })));
});

test("typing while an agent is open steers it and echoes in the viewer; a shell takes no steering", async (t) => {
  const tui = await start(t);
  tui.keys("Down", "Down", "Down", "Enter");
  await tui.waitForScreen(screen(agentView([]), rows("b")));

  tui.type("go left");
  tui.keys("Enter");
  await tui.waitForScreen(screen(agentView(["", " go left", ""]), rows("b", { b: "0s · steered: go left" })));

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), rows("a", { b: "0s · steered: go left" })));
  tui.type("hello");
  tui.keys("Enter");
  await tui.waitForScreen(
    screen(
      [...logView(["one", "two", "three"]), " shell build takes no steering. Esc returns to the main chat."],
      rows("a", { b: "0s · steered: go left" }),
    ),
  );

  // Nothing reached the main session.
  tui.keys("Escape");
  await tui.waitForScreen(screen([], rows("main", { b: "0s · steered: go left" })));
  assert.ok(!tui.events().includes("agent_start"));
});

test("file watchers are released when the viewer closes, switches or the session ends", async (t) => {
  const tui = await start(t);
  await tui.fx({ add: "c", kind: "shell", label: "lint", log: tui.log });
  await tui.watchers(0);
  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), [...rows("a"), "   shell lint · 0s"]));
  await tui.watchers(1);
  tui.keys("Down", "Down", "Down", "Down", "Enter"); // switch to lint
  await tui.waitForScreen(screen([" shell lint · 0s · esc back · ctrl+q stop", " one", " two", " three"], [...rows(), " ● shell lint · 0s"]));
  await tui.watchers(1);
  tui.keys("Escape");
  await tui.waitForScreen(screen([], [...rows("main"), "   shell lint · 0s"]));
  await tui.watchers(0);

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), [...rows("a"), "   shell lint · 0s"]));
  tui.type("/new");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", 2);
  await tui.waitForScreen(screen([], [...rows("main"), "   shell lint · 0s"]));
  await tui.watchers(0);
});

// The overlay: the header, 22 log rows and the steer line fill all 24 rows.
const overlay = (shown, { bottom = "›", below = 0, head = " shell build · 0s · esc back · ctrl+q stop" } = {}) =>
  "\n" + [head + (below ? `  ↓ ${below} below · End` : ""), ...shown.map((l) => ` ${l}`), bottom].join("\n");

test("when the chat lookup fails, the viewer opens as a full-size overlay", async (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const tui = await start(t, { lines });
  await tui.fx({ mismatch: true }); // a fourth child in Pi's document container
  const main = screen([], rows("main"));
  await tui.waitForScreen(main);

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(overlay(lines.slice(-22)));
  appendFileSync(tui.log, "line 31\n");
  const all = [...lines, "line 31"];
  await tui.waitForScreen(overlay(all.slice(-22))); // follows

  // Scrolled up, the view stays put; the header counts what arrives below it.
  tui.keys("PageUp");
  await tui.waitForScreen(overlay(all.slice(0, 22), { below: 9 }));
  appendFileSync(tui.log, "line 32\n");
  await tui.waitForScreen(overlay(all.slice(0, 22), { below: 10 }));

  // Keys typed here go to the overlay's steer line, never to Pi's editor.
  tui.type("hi");
  await tui.waitForScreen(overlay(all.slice(0, 22), { bottom: "› hi", below: 10 }));
  tui.keys("Enter");
  const echo = "shell build takes no steering. Esc returns to the main chat.";
  await tui.waitForScreen(overlay(all.slice(0, 22), { below: 11 }));

  tui.keys("End");
  const end = [...all, "line 32", echo].slice(-22);
  await tui.waitForScreen(overlay(end));

  tui.keys("C-q");
  await tui.waitForScreen(overlay(end, { bottom: " Stop shell build? y stops it, any other key cancels." }));
  tui.type("n");
  await tui.waitForScreen(overlay(end));

  tui.keys("Escape");
  await tui.waitForScreen(main); // the editor is empty
  assert.ok(!tui.events().includes("agent_start"), "nothing typed in the overlay reached the main session");
});

test("in regular mode the viewer is the overlay, so it can follow, pause and jump", async (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const tui = await start(t, { fullscreen: false, lines, replies: ["hello back"] });
  tui.type("hi");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const footer = ["~/cwd", "↑2 ↓3 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"];
  const main = "\n" + [...["", " hi", "", "", " hello back", ""], BORDER, "", BORDER, ...rows("main"), ...footer, ...Array(ROWS).fill("")].slice(0, ROWS).join("\n");
  await tui.waitForScreen(main);

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(overlay(lines.slice(-22)));
  tui.keys("PageUp");
  await tui.waitForScreen(overlay(lines.slice(0, 22), { below: 8 }));
  appendFileSync(tui.log, "line 31\n");
  await tui.waitForScreen(overlay(lines.slice(0, 22), { below: 9 }));
  tui.keys("End");
  await tui.waitForScreen(overlay([...lines, "line 31"].slice(-22)));
  tui.keys("Escape");
  await tui.waitForScreen(main);
});

test("a kitty CSI-u y confirms the stop; a key release does not answer", async (t) => {
  const tui = await start(t);
  tui.keys("Down", "Down", "Down", "Enter");
  const asking = [...rows("b"), " Stop agent scout? y stops it, any other key cancels."];
  tui.type("\x1b[113;5u"); // Ctrl+Q
  await tui.waitForScreen(screen(agentView([]), asking));
  tui.type("\x1b[113;5:3u\x1b[121;1:3u"); // releases of Ctrl+Q and y
  tui.type("\x1b[121u"); // y
  await tui.waitForScreen(screen(agentView([], "stopped 0s"), rows("b", { b: "stopped 0s · stopped by user" })));
});

test("the stop confirmation stays within FleetView's line budget", async (t) => {
  const tui = await start(t);
  await tui.fx(...["c", "d", "e", "f", "g"].map((id) => ({ add: id, kind: "shell", label: id })));
  tui.keys("Down", "Down", "Down", "Enter");
  const view = agentView([]);
  const fleet = [...rows("b"), "   shell c · 0s", "   shell d · 0s", "   … 3 more"];
  await tui.waitForScreen(screen(view, fleet));
  tui.keys("C-q");
  await tui.waitForScreen(
    screen(view, [...rows("b"), "   shell c · 0s", "   … 4 more", " Stop agent scout? y stops it, any other key cancels."]),
  );
});

test("a viewer whose item is pruned closes", async (t) => {
  const tui = await start(t);
  await tui.fx({ finish: "b", status: "completed", result: "ok" });
  tui.keys("Down", "Down", "Down", "Enter");
  await tui.waitForScreen(screen(agentView([], "done 0s"), rows("b", { b: "done 0s · ok" })));
  await tui.fx({ prune: true });
  await tui.waitForScreen(screen([], rows("main").slice(0, 2)));
});

test("Esc puts the chat back even when the viewer's slot was replaced", async (t) => {
  const tui = await start(t, { replies: ["hello back"] });
  tui.type("hi");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const footer = ["~/cwd", "↑2 ↓3 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"];
  const main = screen(["", " hi", "", "", " hello back"], rows("main"), { footer });
  await tui.waitForScreen(main);
  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), rows("a"), { footer }));
  await tui.fx({ unmount: true });
  tui.keys("Escape");
  await tui.waitForScreen(main);
});

const QUEUE = fileURLToPath(new URL("../extensions/queue/index.ts", import.meta.url));
const GATE = fileURLToPath(new URL("./fixtures/queue/gate.ts", import.meta.url));
for (const [order, extensions] of [
  ["fleet first", [...EXTENSIONS, QUEUE, GATE]],
  ["queue first", [QUEUE, ...EXTENSIONS, GATE]],
]) {
  test(`typing while the main run works steers the viewed agent, not the queue (${order}); a slash command goes to Pi`, async (t) => {
    const gate = [{ type: "toolCall", id: "g1", name: "gate", arguments: {} }];
    const tui = await start(t, {
      extensions,
      replies: [gate, "done"],
      before: async (tui) => {
        tui.type("go");
        tui.keys("Enter");
        await tui.waitForEvent("gate_waiting");
      },
    });
    const working = "── ● Working " + "─".repeat(67);
    const footer = ["~/cwd", "↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"];
    const steered = rows("b", { b: "0s · steered: go left" });
    tui.keys("Down", "Down", "Down", "Enter");
    await tui.waitForScreen(screen(agentView([]), rows("b"), { footer, border: working }));
    tui.type("go left");
    tui.keys("Enter");
    const view = agentView(["", " go left", ""]);
    await tui.waitForScreen(screen(view, steered, { footer, border: working }));

    tui.type("/nope"); // not steering: the queue holds it for the main run
    tui.keys("Enter");
    await tui.waitForScreen(screen(view, steered, { footer, border: working, above: [" Steering (1) · next turn", "   /nope"] }));

    writeFileSync(join(tui.cwd, "release-1"), "");
    await tui.waitForEvent("agent_end");
    const after = ["~/cwd", "↑16 ↓3 R2 W17 CH6.5% 0.0%/128k (auto)                                  harness-1"];
    await tui.waitForScreen(screen(view, steered, { footer: after }));
    tui.keys("Escape");
    await tui.waitForScreen(
      screen(["", " go", "", "", "", " gate", " released", "", "", "", " /nope", "", "", " done"], rows("main", { b: "0s · steered: go left" }), { footer: after }),
    );
  });
}

for (const [order, extensions] of [
  ["fleet first", [...EXTENSIONS, QUEUE, GATE]],
  ["queue first", [QUEUE, ...EXTENSIONS, GATE]],
]) {
  test(`editing a queued row while viewing an agent saves the row (${order})`, async (t) => {
    const gate = [{ type: "toolCall", id: "g1", name: "gate", arguments: {} }];
    const tui = await start(t, {
      extensions,
      replies: [gate, "done"],
      before: async (tui) => {
        tui.type("go");
        tui.keys("Enter");
        await tui.waitForEvent("gate_waiting");
        tui.type("first");
        tui.keys("Enter"); // queued for the main run
      },
    });
    const working = "── ● Working " + "─".repeat(67);
    const footer = ["~/cwd", "↑2 ↓2 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"];
    const opts = (above, editor = "") => ({ footer, border: working, above, editor });
    tui.keys("Down", "Down", "Down", "Enter");
    await tui.waitForScreen(screen(agentView([]), rows("b"), opts([" Steering (1) · next turn", "   first"])));
    tui.keys("M-Up"); // edit the row in Pi's editor
    await tui.waitForScreen(screen(agentView([]), rows("b"), opts([" Steering (1) · next turn", " › first"], "first")));
    tui.type(" two");
    tui.keys("Enter"); // saves the row; the agent gets nothing
    await tui.waitForScreen(screen(agentView([]), rows("b"), opts([" Steering (1) · next turn", "   first two"])));
  });
}

test("switching to regular mode while viewing moves the item to the overlay", async (t) => {
  const tui = await start(t);
  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(screen(logView(["one", "two", "three"]), rows("a")));
  tui.type("/settings");
  tui.keys("Enter");
  tui.type("tui mode");
  await tui.waitForScreen(
    screen([...logView(["one", "two", "three"]), "", "", "", "", "", ""], rows("a"), {
      editor: ["> tui mode", "", "→ TUI mode                          fullscreen", "", "  Interface layout; fullscreen mode is experimental", "", "  Type to search · Enter/Space to change · Esc to cancel"],
    }),
  );
  tui.keys("Enter"); // fullscreen → regular
  await tui.waitForScreen(overlay(["one", "two", "three", ...Array(19).fill("")]));
  // Regular mode: the chat is back in place, content from the top.
  const regular = (editor) =>
    "\n" + ["", " TUI mode: regular", "", BORDER, ...editor, BORDER, ...rows("main"), ...FOOTER, ...Array(ROWS).fill("")].slice(0, ROWS).join("\n");
  tui.keys("Escape"); // closes the viewer
  await tui.waitForScreen(
    regular(["> tui mode", "", "→ TUI mode                          regular", "", "  Interface layout; fullscreen mode is experimental", "", "  Type to search · Enter/Space to change · Esc to cancel"]),
  );
  tui.keys("Escape"); // closes the settings
  await tui.waitForScreen(regular([""]));
});
