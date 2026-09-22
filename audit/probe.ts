import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Audit probe: records externally observable registration state at startup.
// Loaded via `pi -e` alongside the monorepo package (never part of the
// package surface itself). Each section is best-effort so a pi API change
// shows up as a missing section, not a crashed run.
// Mirrors parseSkillsFromPrompt in checks.mjs (kept inline: the probe runs
// under pi's extension loader, so it can't import the harness module).
function parseSkillsFromPrompt(prompt: string): Array<Record<string, unknown>> {
  const unescape = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(prompt)?.[1] ?? "";
  const skills: Array<Record<string, unknown>> = [];
  for (const m of block.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const body = m[1];
    const field = (tag: string): string | undefined => {
      const v = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(body)?.[1];
      return v === undefined ? undefined : unescape(v);
    };
    skills.push({ name: field("name"), description: field("description"), location: field("location") });
  }
  return skills;
}

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
    // No skill-inventory API on pi/ctx (checked 0.87.1: only
    // resources_discover, which extensions implement rather than query).
    // Skills surface observably as <available_skills> XML in the prompt.
    try {
      const maybe = (pi as unknown as { getSkills?: unknown }).getSkills;
      if (typeof maybe === "function") {
        const got = (maybe as () => unknown[])();
        snap.skills = (Array.isArray(got) ? got : []).map((s) => {
          const skill = s as Record<string, unknown>;
          return { name: skill.name, description: skill.description, location: skill.filePath ?? skill.location };
        });
      } else if (typeof snap.systemPrompt === "string") {
        snap.skills = parseSkillsFromPrompt(snap.systemPrompt);
      } else {
        snap.skillsError = "no getSkills API and no system prompt to parse";
      }
    } catch (e) {
      snap.skillsError = String(e);
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
