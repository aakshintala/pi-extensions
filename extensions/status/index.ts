// Rig status (spec #38): one quota client behind get_quotas, /quota and the
// two-line footer. No quota text is added to agent runs.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { registerFooter, type FooterDeps } from "./footer.ts";
import { registerQuota } from "./quota.ts";

export type StatusDeps = FooterDeps & { fetch?: typeof fetch };

export default function (pi: ExtensionAPI, deps: StatusDeps = {}) {
  const rig = rigSettings(getAgentDir());
  const settings = rig.declare("status", [
    { key: "quotaPort", type: "integer", min: 1, max: 65535, default: 8787, description: "QuotaBar.app feed port" },
    { key: "quotaRefreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Quota polling interval" },
  ]);
  pi.on("session_start", (_event, ctx) => rig.notifyWarnings(ctx.ui));
  const footer = registerFooter(pi, deps);
  // The footer sees every feed the one client fetches by tapping its fetch;
  // an aborted fetch (shutdown, port change) leaves the footer as it was.
  // ponytail: a feed listener on the client would be cleaner; quota.ts is fenced by PR #87.
  const fetchFn = deps.fetch ?? fetch;
  registerQuota(pi, settings, {
    async fetch(url, init) {
      try {
        const res = await fetchFn(url, init);
        const json = res.ok ? await res.clone().json() : null;
        footer.quotas(Array.isArray(json?.providers) ? json : null);
        return res;
      } catch (e) {
        if (!init?.signal?.aborted) footer.quotas(null);
        throw e;
      }
    },
  });
}
