import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Custom entry that subagents (#26) write first in every child session. */
export const MARKER = "rig.subagent";

/** Whether this session is a subagent's: it holds the `rig.subagent` entry. */
export const isChild = (ctx: Pick<ExtensionContext, "sessionManager">) =>
  ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === MARKER);
