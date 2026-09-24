// Loads stamp with UTC display for deterministic 12-hour clock assertions.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../../shared/settings/index.ts";
import stamp from "../../../extensions/stamp/index.ts";
import { SETTINGS } from "../../../extensions/stamp/settings.ts";

export default function (pi: ExtensionAPI) {
  process.env.TZ = "UTC";
  rigSettings(getAgentDir()).declare("stamp", SETTINGS).set("timeZone", "UTC");
  stamp(pi);
}
