// Test-only wrapper for the stamp TUI tests: loads stamp with a fixed clock in UTC,
// pins every message timestamp to the same instant, and reports each stamp setting
// change as an event `stamp.<key>=<value>` in $PI_HARNESS_EVENTS.
import { appendFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../../shared/settings/index.ts";
import stamp from "../../../extensions/stamp/index.ts";

export const T = Date.UTC(2026, 8, 23, 14, 5, 9);

export default function (pi: ExtensionAPI) {
  process.env.TZ = "UTC";
  for (const name of ["message_start", "message_update", "message_end", "turn_end"] as const) {
    pi.on(name, (event) => void (event.message.timestamp = T));
  }
  stamp(pi, { now: () => T });
  const section = rigSettings(getAgentDir()).sections().find((s) => s.name === "stamp")!;
  section.onChange((key, value) => appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: `stamp.${key}=${value}` }) + "\n"));
}
