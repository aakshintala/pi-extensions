// Rig status (spec #38): one quota client behind get_quotas, /quota and the
// two-line footer. No quota text is added to agent runs.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings, type Section } from "../../shared/settings/index.ts";
import { registerFooter, type FooterDeps } from "./footer.ts";
import { registerQuota, type ClientOptions, type Feed } from "./quota.ts";

export type StatusDeps = FooterDeps & { fetch?: typeof fetch; quotaTimers?: ClientOptions["timers"] };

export default function (pi: ExtensionAPI, deps: StatusDeps = {}) {
  const rig = rigSettings(getAgentDir());
  const settings = rig.declare("status", [
    { key: "quotaPort", type: "integer", min: 1, max: 65535, default: 8787, description: "QuotaBar.app feed port" },
    { key: "quotaRefreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Quota polling interval" },
  ]);
  pi.on("session_start", (_event, ctx) => rig.notifyWarnings(ctx.ui));
  const footer = registerFooter(pi, deps);
  mirrorQuotas(pi, settings, footer, deps);
}

/**
 * Registers the quota client with a fetch that mirrors its cache into the
 * footer: a new feed replaces it; a failed or aborted fetch (timeout, shutdown)
 * keeps it while it is younger than the refresh interval and then shows it as
 * unavailable; a feed that arrives after an abort is ignored; and a port change
 * clears it, as the client does.
 */
function mirrorQuotas(pi: ExtensionAPI, settings: Section, footer: { quotas(feed: Feed | null | undefined): void }, deps: StatusDeps) {
  // ponytail: copies the client's cache rules; a feed listener on the client replaces this once PR #87 frees quota.ts.
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let fetchedAt = -Infinity;
  registerQuota(
    pi,
    settings,
    {
      now,
      ...(deps.quotaTimers && { timers: deps.quotaTimers }),
      async fetch(url, init) {
        const aborted = () => init?.signal?.aborted;
        try {
          const res = await fetchFn(url, init);
          const json = res.ok ? await res.clone().json() : null;
          if (!Array.isArray(json?.providers)) throw new Error("bad feed");
          if (!aborted()) {
            fetchedAt = now();
            footer.quotas(json);
          }
          return res;
        } catch (e) {
          // Aborts (timeout, shutdown) too: the client drops a stale feed on any failed fetch.
          if (now() - fetchedAt >= (settings.get("quotaRefreshSeconds") as number) * 1000) footer.quotas(null);
          throw e;
        }
      },
    },
  );
  // Registered after the client's own listener, so both drop the feed together.
  settings.onChange((key) => {
    if (key !== "quotaPort") return;
    fetchedAt = -Infinity;
    footer.quotas(undefined);
  });
}
