import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, createProvider, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

// Audit probe: records externally observable registration state at
// session_start. Loaded via `pi -e`, never part of the package surface.
// Each section is best-effort so a pi API change shows up as a missing
// section, not a crashed run. PI_AUDIT_EXIT stops pi right after the
// snapshot so a live (credentialed) run never reaches a model call.
// PI_AUDIT_FAUX registers faux model audit/probe and re-records
// systemPrompt from the request it receives: that is the prompt after every
// before_agent_start handler ran, which session_start cannot see.
export default function (pi: ExtensionAPI) {
  if (process.env.PI_AUDIT_FAUX) {
    const core = createFauxCore({ provider: "audit", models: [{ id: "probe" }] });
    core.setResponses(["ok"]);
    const record = (stream: typeof core.stream): typeof core.stream => (model, context, options) => {
      const snap = JSON.parse(readFileSync(process.env.PI_AUDIT_SNAP!, "utf8"));
      snap.systemPrompt = getCurrentSystemPrompt(context.messages as any);
      snap.requestCaptured = true;
      writeFileSync(process.env.PI_AUDIT_SNAP!, JSON.stringify(snap));
      return stream(model, context, options);
    };
    pi.registerProvider(
      createProvider({
        id: core.provider,
        auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
        models: core.models,
        api: { stream: record(core.stream), streamSimple: record(core.streamSimple) },
      }),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
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

    writeFileSync(process.env.PI_AUDIT_SNAP!, JSON.stringify(snap));
    if (process.env.PI_AUDIT_EXIT) process.exit(0);
  });

  pi.on("session_shutdown", async () => {
    const marker = process.env.PI_AUDIT_SHUTDOWN_MARKER;
    if (marker) writeFileSync(marker, "shutdown-ok");
  });
}
