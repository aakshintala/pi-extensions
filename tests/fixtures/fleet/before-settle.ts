// Test-only: calls globalThis[Symbol.for("pi-rig.test.beforeSettle")] at every
// agent_before_settle. Pi runs these handlers in load order and loads extension
// paths before inline factories, so load this path before the fleet extension to
// run ahead of its session-end wait.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_before_settle", () => (globalThis as any)[Symbol.for("pi-rig.test.beforeSettle")]?.());
}
