// Marks the pi session as a subagent child, as #26 does with its first entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => pi.appendEntry("rig.subagent", { agentId: "a1", parentSessionId: "p1" }));
}
