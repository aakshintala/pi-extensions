import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Retained slash-command surface (issue #8, part of #1). Command-only:
// registered handlers with observable UI effects, no model-facing tools,
// no background resources, no dependencies. Full backing behavior for
// agents/tasks/jobs/skills/intercom lands in later migration steps; until
// then empty-state commands say so via one shared table, and staged
// placeholders (kit topics, ponytail-review) are labeled as unimplemented,
// never presented as measured fact.

const MODES = ["lite", "full", "ultra"] as const;
const DEFAULT_MODE = "full";

// Per-session Ponytail mode, keyed by session identity. No module-global
// mode value: sessions never share state, and a missing entry is the default.
const sessionModes = new WeakMap<object, string>();

// Staged empty states: backing trackers land in later migration steps.
const EMPTY_STATES: Record<string, { description: string; message: string }> = {
  agents: { description: "Manage subagent sessions", message: "No active subagents" },
  tasks: { description: "Track session tasks", message: "No active tasks" },
  bg: { description: "Manage background processes", message: "No background processes" },
  jobs: { description: "Manage background jobs", message: "No background jobs" },
  intercom: { description: "Coordinate with peer sessions", message: "No intercom peers" },
};

// Staged admin topics: detail views land with their owning migration steps.
const KIT_TOPICS = ["search", "structured-return", "stamps", "tool-display", "diagnostics"];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session with familiar terminology",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("theme", {
    description: "Switch themes interactively",
    handler: async (args, ctx) => {
      // Placeholder (owning later step): interactive theme picker; direct set only.
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /theme <name>", "info");
        return;
      }
      const result = ctx.setTheme(name);
      ctx.ui.notify(
        result.success ? `Theme switched to ${name}` : `Unknown theme: ${name}`,
        result.success ? "info" : "error",
      );
    },
  });

  for (const [name, { description, message }] of Object.entries(EMPTY_STATES)) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        ctx.ui.notify(message, "info");
      },
    });
  }

  pi.registerCommand("skills", {
    description: "Manage skills",
    handler: async (_args, ctx) => {
      // Placeholder (owning later step): verified against fakes only;
      // real-pi skills-source verification belongs to the skills step.
      const names = pi
        .getCommands()
        .filter((c) => c.source === "skill")
        .map((c) => `/${c.name}`);
      ctx.ui.notify(names.length > 0 ? names.join("\n") : "No skills installed", "info");
    },
  });

  pi.registerCommand("usage", {
    description: "Inspect cost and prompt composition",
    handler: async (_args, ctx) => {
      // Placeholder (owning later step): cost detail; context tokens only.
      const usage = ctx.getContextUsage();
      ctx.ui.notify(
        usage?.tokens != null
          ? `Context: ${usage.tokens} tokens (${usage.percent ?? "?"}% of window)`
          : "Context usage unknown",
        "info",
      );
    },
  });

  pi.registerCommand("context", {
    description: "Inspect context composition",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().length;
      const promptChars = ctx.getSystemPrompt().length;
      ctx.ui.notify(`Context: ${entries} session entries, system prompt ${promptChars} chars`, "info");
    },
  });

  pi.registerCommand("ponytail", {
    description: `Show or set Ponytail mode (${MODES.join(", ")})`,
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (!mode) {
        ctx.ui.notify(`Ponytail mode: ${sessionModes.get(ctx.sessionManager) ?? DEFAULT_MODE}`, "info");
        return;
      }
      if (!(MODES as readonly string[]).includes(mode)) {
        ctx.ui.notify(`Unknown Ponytail mode: ${mode} (${MODES.join(", ")})`, "error");
        return;
      }
      sessionModes.set(ctx.sessionManager, mode);
      ctx.ui.notify(`Ponytail mode: ${mode}`, "info");
    },
  });

  pi.registerCommand("kit", {
    description: "Infrequent administration for search, display, and diagnostics",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify(`kit topics (not yet implemented): ${KIT_TOPICS.join(", ")}`, "info");
        return;
      }
      ctx.ui.notify(
        KIT_TOPICS.includes(topic) ? `kit ${topic}: not yet implemented` : `Unknown kit topic: ${topic}`,
        KIT_TOPICS.includes(topic) ? "info" : "error",
      );
    },
  });

  pi.registerCommand("skill:ponytail-review", {
    description: "On-demand Ponytail complexity audit",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().length;
      ctx.ui.notify(
        `Ponytail review not yet implemented (${entries} session entries in scope)`,
        "info",
      );
    },
  });
}
