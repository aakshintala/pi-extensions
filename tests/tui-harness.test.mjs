import { test } from "node:test";
import { startTui } from "./helpers/tui.mjs";

test("tmux harness: pi shows a scripted reply", async (t) => {
  const tui = await startTui(t, { replies: ["Hello from the scripted model."] });

  tui.type("say hello");
  tui.keys("Enter");
  await tui.waitForEvent("agent_end");

  // Row 1 is blank: pi's quiet-startup header.
  await tui.waitForScreen(`

 say hello


 Hello from the scripted model.

────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/cwd
↑4 ↓8 W4 CH0.0% 0.0%/128k (auto)                                       harness-1`);
});
