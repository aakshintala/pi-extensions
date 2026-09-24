// Rig status (spec #38): one quota client behind get_quotas, /quota and the
// two-line footer. No quota text is added to agent runs.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { registerFooter, type FooterDeps } from "./footer.ts";
import { registerQuota, type ClientOptions } from "./quota.ts";

type StatusDeps = FooterDeps & { fetch?: typeof fetch; quotaTimers?: ClientOptions["timers"] };

export default function (pi: ExtensionAPI, deps: StatusDeps = {}) {
  const rig = rigSettings(getAgentDir());
  const settings = rig.declare("status", [
    { key: "quota", type: "boolean", default: true, description: "QuotaBar integration: get_quotas, /quota, footer quotas (applies on /reload)" },
    { key: "quotaPort", type: "integer", min: 1, max: 65535, default: 8787, description: "QuotaBar.app feed port" },
    { key: "quotaRefreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Quota polling interval" },
  ]);
  const footer = registerFooter(pi, deps);
  // Read once: without QuotaBar there is no tool, command, polling or footer segment.
  if (!settings.get("quota")) return;
  const off = registerQuota(pi, settings, { fetch: deps.fetch, now: deps.now, timers: deps.quotaTimers }).onFeed(footer.quotas);
  pi.on("session_shutdown", () => void off()); // idempotent: a second delete is a no-op
}
