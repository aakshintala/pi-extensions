import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Always-on ponytail guidance (spec #37), added as one named system-prompt
// section so other extensions' sections and prompt caching survive.
export const PONYTAIL = `Build the simplest thing that works. Read the task and the code it touches first, then take the first rung that holds:
1. Skip what nobody asked for.
2. Reuse what this codebase already has.
3. Use the standard library.
4. Use a native platform feature.
5. Use an installed dependency; add a new one only when a few lines won't do.
6. Only then write the minimum new code.
Fix bugs at the root cause: check every caller, then fix the shared code once.
Keep, however small the change: validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything the user asked for.`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    (event.systemPromptOptions.sections ??= {}).ponytail = PONYTAIL;
  });
}
