// The status footer in a real pi (spec #38, ADR 0001): two lines, git dirty
// state after a tool writes a file, a fresh footer after /new, and truncation
// at a narrow width. The
// fixture makes cwd a clean git repo and serves a fixed quota feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/status/index.ts", import.meta.url));
const rows = (text, n) => text + "\n".repeat(n);

// The pane's rows with their SGR colours. The harness captures plain text only,
// so find this test's tmux server (named pi-rig-<our pid>-*) by its pane's pid.
function colouredScreen(tui) {
  const dir = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid()}`);
  const tmux = (name, ...a) => spawnSync("tmux", ["-L", name, ...a], { encoding: "utf8" }).stdout;
  const name = readdirSync(dir).find((n) => n.startsWith(`pi-rig-${process.pid}-`) && Number(tmux(n, "display-message", "-p", "#{pane_pid}")) === tui.pid);
  return tmux(name, "capture-pane", "-p", "-e").split("\n");
}
// Pi's default theme in 256 colours: accent, warning, error; dim.
const [ACCENT, WARNING, ERROR, DIM] = [109, 226, 167, 241].map((c) => (s) => `\x1b[38;5;${c}m${s}`);
const OFF = "\x1b[39m";

async function start(t, options) {
  const tui = await startTui(t, { extensions: [FIXTURE], ...options });
  t.after(() => assert.deepEqual(liveGroup(tui.pid), []));
  return tui;
}

test("two-line footer; the dirty mark appears after a tool writes a file", async (t) => {
  const write = { type: "toolCall", id: "c1", name: "write", arguments: { path: "b.txt", content: "b\n" } };
  const tui = await start(t, { replies: [[write], "Done."] });
  await tui.waitForScreen(rows(`

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
harness-1 off  │  in 0 out 0 cache -- $0.000  │  ctx [░░░░░░░░░░] 0%
~/cwd main  │  Q claude 78%/41% · codex 12%  │  TTFT -- · TPS --`, 18));
  // Colours: context in accent below 70%; claude's lowest bucket (41%) in warning, codex (12%) in error.
  const footer = colouredScreen(tui).slice(4, 6);
  assert.ok(footer[0].endsWith(`${ACCENT("ctx [░░░░░░░░░░] 0%")}${OFF}`), JSON.stringify(footer[0]));
  assert.ok(footer[1].includes(`${DIM("Q")}${OFF} ${WARNING("claude 78%/41%")}${DIM(" · ")}${ERROR("codex 12%")}${OFF}`), JSON.stringify(footer[1]));

  tui.type("go");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");
  await tui.waitForScreen(rows(`

 go



 write b.txt

 b


 Done.

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
harness-1 off  │  in 26 out 12 cache 4% $0.000  │  ctx [░░░░░░░░░░] 0%
~/cwd main*  │  Q claude 78%/41% · codex 12%  │  TTFT -- · TPS --`, 7));
  const row = colouredScreen(tui).find((r) => r.startsWith("~/cwd"));
  assert.ok(row.startsWith(`~/cwd ${ACCENT("main")}${WARNING("*")}${OFF}`), JSON.stringify(row));

  // A new session starts from zero usage and checks git again at once.
  tui.type("/new");
  tui.keys("Enter");
  await tui.waitForEvent("session_start", 2);
  await tui.waitForScreen(rows(`


 ✓ New session started


────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
harness-1 off  │  in 0 out 0 cache -- $0.000  │  ctx [░░░░░░░░░░] 0%
~/cwd main*  │  Q claude 78%/41% · codex 12%  │  TTFT -- · TPS --`, 14));
});

test("footer lines are truncated to a narrow terminal", async (t) => {
  const tui = await start(t, { cols: 40 });
  await tui.waitForScreen(rows(`

────────────────────────────────────────

────────────────────────────────────────
harness-1 off  │  in 0 out 0 cache --...
~/cwd main  │  Q claude 78%/41% · cod...`, 18));
});
