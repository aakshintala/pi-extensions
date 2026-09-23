// The status footer in a real pi (spec #38, ADR 0001): two lines, git dirty
// state after a tool writes a file, a fresh footer after /new, and truncation
// at a narrow width. The
// fixture makes cwd a clean git repo and serves a fixed quota feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { liveGroup, startTui } from "./helpers/tui.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/status/index.ts", import.meta.url));
const rows = (text, n) => text + "\n".repeat(n);

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
