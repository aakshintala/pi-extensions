import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Retained slash-command surface (issue #8, part of #1). Command-only:
// registered handlers with observable UI effects, no model-facing tools,
// no background resources, no dependencies. Full backing behavior for
// agents/tasks/jobs/skills/intercom lands in later migration steps; until
// then list-type commands report this package's (empty) state honestly.

// ponytail: module-level mode flag; per-session store if modes ever diverge.
let ponytailMode = "full";

const KIT_TOPICS: Record<string, string> = {
  search: "Search administration: grep/find override status.",
  "structured-return": "Structured-return statistics: no runs recorded.",
  stamps: "Stamp display: event stamps only, no per-event records.",
  "tool-display": "Tool display: compact rendering, errors expand.",
  diagnostics: "Extension diagnostics: commands package ok.",
};

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

  pi.registerCommand("agents", {
    description: "Manage subagent sessions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No active subagents", "info");
    },
  });

  pi.registerCommand("tasks", {
    description: "Track session tasks",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No active tasks", "info");
    },
  });

  pi.registerCommand("bg", {
    description: "Manage background processes",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No background processes", "info");
    },
  });

  pi.registerCommand("jobs", {
    description: "Manage background jobs",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No background jobs", "info");
    },
  });

  pi.registerCommand("skills", {
    description: "Manage skills",
    handler: async (_args, ctx) => {
      const names = pi
        .getCommands()
        .filter((c) => c.source === "skill")
        .map((c) => `/${c.name}`);
      ctx.ui.notify(names.length > 0 ? names.join("\n") : "No skills installed", "info");
    },
  });

  pi.registerCommand("intercom", {
    description: "Coordinate with peer sessions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No intercom peers", "info");
    },
  });

  pi.registerCommand("usage", {
    description: "Inspect cost and prompt composition",
    handler: async (_args, ctx) => {
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
    description: "Show or set Ponytail mode (lite, full, ultra)",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (!mode) {
        ctx.ui.notify(`Ponytail mode: ${ponytailMode}`, "info");
        return;
      }
      if (!["lite", "full", "ultra"].includes(mode)) {
        ctx.ui.notify(`Unknown Ponytail mode: ${mode} (lite, full, ultra)`, "error");
        return;
      }
      ponytailMode = mode;
      ctx.ui.notify(`Ponytail mode: ${ponytailMode}`, "info");
    },
  });

  pi.registerCommand("kit", {
    description: "Infrequent administration for search, display, and diagnostics",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify(`kit topics: ${Object.keys(KIT_TOPICS).join(", ")}`, "info");
        return;
      }
      const detail = KIT_TOPICS[topic];
      ctx.ui.notify(detail ?? `Unknown kit topic: ${topic}`, detail ? "info" : "error");
    },
  });

  pi.registerCommand("skill:ponytail-review", {
    description: "On-demand Ponytail complexity audit",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries().length;
      ctx.ui.notify(`Ponytail review: ${entries} session entries, no complexity findings recorded`, "info");
    },
  });
}
