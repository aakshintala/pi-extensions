import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Audit probe: records externally observable registration state at
// session_start. Loaded via `pi -e`, never part of the package surface.
// Each section is best-effort so a pi API change shows up as a missing
// section, not a crashed run. PI_AUDIT_EXIT stops pi right after the
// snapshot so a live (credentialed) run never reaches a model call.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const fs = await import("node:fs");
    const snap: Record<string, unknown> = {};
    const grab = (key: string, fn: () => unknown) => {
      try {
        snap[key] = fn();
      } catch (e) {
        snap[`${key}Error`] = String(e);
      }
    };
    grab("activeTools", () => pi.getActiveTools());
    grab("allTools", () =>
      pi.getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        promptGuidelines: t.promptGuidelines,
        sourceInfo: t.sourceInfo,
      })),
    );
    grab("commands", () => pi.getCommands().map((c) => ({ name: c.name, source: c.source })));
    grab("models", () => ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id })));
    grab("systemPrompt", () => ctx.getSystemPrompt());

    fs.writeFileSync(process.env.PI_AUDIT_SNAP!, JSON.stringify(snap));
    if (process.env.PI_AUDIT_EXIT) process.exit(0);
  });

  pi.on("session_shutdown", async () => {
    const marker = process.env.PI_AUDIT_SHUTDOWN_MARKER;
    if (marker) (await import("node:fs")).writeFileSync(marker, "shutdown-ok");
  });
}
