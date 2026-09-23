// Rig status: one quota client behind get_quotas and /quota (spec #38).
// The footer is ticket #66.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { registerQuota } from "./quota.ts";

export default function (pi: ExtensionAPI) {
  const rig = rigSettings(getAgentDir());
  const settings = rig.declare("status", [
    { key: "quotaPort", type: "integer", min: 1, max: 65535, default: 8787, description: "QuotaBar.app feed port" },
    { key: "quotaRefreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Quota polling interval" },
  ]);
  pi.on("session_start", (_event, ctx) => rig.notifyWarnings(ctx.ui));
  registerQuota(pi, settings);
}
