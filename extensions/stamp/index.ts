// One compact duration stamp for each settled agent run.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { STAMP_ENTRY_TYPE, stampRenderer } from "./render.ts";
import { frozenSettings, SETTINGS } from "./settings.ts";

export default function stamp(pi: ExtensionAPI, { now = Date.now }: { now?: () => number } = {}) {
  const section = rigSettings(getAgentDir()).declare("stamp", SETTINGS);
  let live: ReturnType<typeof frozenSettings> | undefined;
  const settings = () => (live ??= frozenSettings(section)).get();
  let startedAt: number | undefined;
  pi.registerEntryRenderer(STAMP_ENTRY_TYPE, stampRenderer(settings));
  pi.on("session_start", () => { startedAt = undefined; });
  pi.on("agent_start", () => { startedAt ??= now(); });
  pi.on("agent_settled", () => {
    const endedAt = now();
    if (startedAt === undefined || endedAt < startedAt) { startedAt = undefined; return; }
    pi.appendEntry(STAMP_ENTRY_TYPE, { version: 1, startedAt, endedAt });
    startedAt = undefined;
  });
  pi.on("session_shutdown", () => { live?.stop(); live = undefined; startedAt = undefined; });
}
