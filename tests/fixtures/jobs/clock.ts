// Test-only: holds the fleet clock at 0 and the working indicator still, so screens
// never change while a command runs, and removes the jobs' log directories once the session has shut down.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleet } from "../../../shared/fleet/index.ts";

export default function (pi: ExtensionAPI) {
  fleet().now = () => 0;
  pi.on("session_start", (_e, ctx) => ctx.ui.setWorkingIndicator({ frames: ["●"] }));
  // Loaded after the jobs extension, so its shutdown has already stopped every job.
  pi.on("session_shutdown", () => {
    for (const item of fleet().items()) if ("log" in item.view) rmSync(dirname(item.view.log), { recursive: true, force: true });
  });
}
