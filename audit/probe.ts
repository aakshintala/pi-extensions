import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Audit probe: records externally observable registration state at startup.
// Loaded via `pi -e` alongside the monorepo package (never part of the
// package surface itself). Each section is best-effort so a pi API change
// shows up as a missing section, not a crashed run.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const fs = await import("node:fs");
    const snap: Record<string, unknown> = {};

    try {
      snap.activeTools = pi.getActiveTools();
    } catch (e) {
      snap.activeToolsError = String(e);
    }
    try {
      snap.allTools = (pi.getAllTools() as unknown[]).map((t) => {
        const tool = t as Record<string, unknown>;
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines,
          sourceInfo: tool.sourceInfo,
        };
      });
    } catch (e) {
      snap.allToolsError = String(e);
    }
    try {
      snap.commands = pi.getCommands();
    } catch (e) {
      snap.commandsError = String(e);
    }
    try {
      snap.models = ctx.modelRegistry
        .getAvailable()
        .map((m) => ({ provider: m.provider, id: m.id }));
    } catch (e) {
      snap.modelsError = String(e);
    }
    try {
      snap.systemPrompt = ctx.getSystemPrompt();
    } catch (e) {
      snap.systemPromptError = String(e);
    }

    const snapPath = process.env.PI_AUDIT_SNAP;
    if (snapPath) fs.writeFileSync(snapPath, JSON.stringify(snap));
  });

  pi.on("session_shutdown", async () => {
    const marker = process.env.PI_AUDIT_SHUTDOWN_MARKER;
    if (marker) {
      const fs = await import("node:fs");
      fs.writeFileSync(marker, "shutdown-ok");
    }
  });
}
