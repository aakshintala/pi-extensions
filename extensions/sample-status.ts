import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Trivial proof of the package conventions: sets a footer status while the
// session is alive, clears it idempotently on shutdown. No dependencies,
// no credentials, no background resources.
const SLOT = "sample-status";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(SLOT, "sample-status: active");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent: clearing an already-cleared slot is a no-op.
    ctx.ui.setStatus(SLOT, undefined);
  });
}
