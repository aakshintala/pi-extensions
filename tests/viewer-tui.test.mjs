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
const screen = (chat, fleet, { editor = "", footer = FOOTER } = {}) => {
  const dock = [BORDER, editor, BORDER, ...fleet, ...footer];
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

async function start(t, { lines = ["one", "two", "three"], fullscreen = true, ...options } = {}) {
  const tui = await startTui(t, { extensions: EXTENSIONS, args: fullscreen ? ["--tui-mode", "fullscreen"] : [], ...options });
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

test("when the chat lookup fails, the viewer opens as a full-size overlay", async (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const tui = await start(t, { lines });
  await tui.fx({ mismatch: true }); // a fourth child in Pi's document container
  const main = screen([], rows("main"));
  await tui.waitForScreen(main);
  // The header, 22 log rows and the steer line fill all 24 rows.
  const overlay = (shown, bottom = "›") =>
    "\n" + [" shell build · 0s · esc back · ctrl+q stop", ...shown.map((l) => ` ${l}`), bottom].join("\n");

  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(overlay(lines.slice(-22)));
  appendFileSync(tui.log, "line 31\n");
  const all = [...lines, "line 31"];
  await tui.waitForScreen(overlay(all.slice(-22))); // follows

  tui.keys("PageUp");
  await tui.waitForScreen(overlay(all.slice(0, 22)));
  appendFileSync(tui.log, "line 32\n");
  tui.type("hi");
  await tui.waitForScreen(overlay(all.slice(0, 22), "› hi"));
  tui.keys("Enter"); // the redraw that clears the steer line reads line 32 too
  await tui.waitForScreen(overlay(all.slice(0, 22)));

  tui.keys("End");
  const echo = "shell build takes no steering. Esc returns to the main chat.";
  await tui.waitForScreen(overlay([...all, "line 32", echo].slice(-22)));

  tui.keys("C-q");
  await tui.waitForScreen(overlay([...all, "line 32", echo].slice(-22), " Stop shell build? y stops it, any other key cancels."));
  tui.type("n");
  await tui.waitForScreen(overlay([...all, "line 32", echo].slice(-22)));

  tui.keys("Escape");
  await tui.waitForScreen(main);
});

test("in regular mode the chat area is swapped too", async (t) => {
  const tui = await start(t, { fullscreen: false, replies: ["hello back"] });
  tui.type("hi");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  const footer = ["~/cwd", "↑2 ↓3 W2 CH0.0% 0.0%/128k (auto)                                       harness-1"];
  const below = (chat, on) => "\n" + [...chat, BORDER, "", BORDER, ...rows(on), ...footer, ...Array(ROWS).fill("")].slice(0, ROWS).join("\n");
  const main = below(["", " hi", "", "", " hello back", ""], "main");
  await tui.waitForScreen(main);
  tui.keys("Down", "Down", "Enter");
  await tui.waitForScreen(below([...logView(["one", "two", "three"]), ""], "a"));
  tui.keys("Escape");
  await tui.waitForScreen(main);
});
