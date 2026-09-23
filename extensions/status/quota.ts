// The rig's one quota client: QuotaBar.app's loopback feed, cached, with
// concurrent requests merged into one fetch. Serves get_quotas and /quota,
// and (ticket #66) the footer. Polls only while a TUI session is active.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FOOTER_TIMEOUT_MS = 5_000;
export const CALL_TIMEOUT_MS = 8_000;

export type Bucket = {
  label: string;
  percentRemaining: number;
  resetsAt?: string | null;
  resetText?: string | null;
  status: string;
};
export type Provider = {
  id: string;
  name?: string;
  tier?: string | null;
  status?: string;
  unavailable?: string | null;
  throttledUntil?: string | null;
  quotas: Bucket[];
};
export type Feed = { generatedAt?: string; providers: Provider[]; disabledProviderIds?: string[] };

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;

export interface ClientOptions {
  port: () => number;
  refreshMs: () => number;
  fetch?: typeof fetch;
  timers?: Timers;
  now?: () => number;
}

export type QuotaClient = ReturnType<typeof createQuotaClient>;

export function createQuotaClient({ port, refreshMs, fetch: fetchFn = fetch, timers = globalThis, now = Date.now }: ClientOptions) {
  let feed: Feed | null = null;
  let fetchedAt = -Infinity;
  let inFlight: Promise<Feed | null> | null = null;
  let abort: AbortController | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;

  async function load(timeoutMs: number): Promise<Feed | null> {
    const controller = (abort = new AbortController());
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port()}/quotas`, { signal: controller.signal });
      const json = res.ok ? await res.json() : null;
      if (!Array.isArray(json?.providers)) throw new Error("bad feed");
      feed = json as Feed;
      fetchedAt = now();
    } catch {
      feed = null;
    } finally {
      timers.clearTimeout(timer);
      if (abort === controller) {
        abort = null;
        inFlight = null;
      }
    }
    return feed;
  }

  const client = {
    /** The cached feed while younger than the refresh interval, else one (shared) fetch. Null when QuotaBar is unreachable. */
    get({ force = false, timeoutMs = CALL_TIMEOUT_MS } = {}): Promise<Feed | null> {
      if (!force && feed && now() - fetchedAt < refreshMs()) return Promise.resolve(feed);
      return (inFlight ??= load(timeoutMs));
    },
    start() {
      if (poll) return;
      const refresh = () => void client.get({ force: true, timeoutMs: FOOTER_TIMEOUT_MS });
      refresh();
      poll = timers.setInterval(refresh, refreshMs());
    },
    /** Idempotent: stops polling and aborts the in-flight fetch. */
    stop() {
      if (poll) timers.clearInterval(poll);
      poll = undefined;
      abort?.abort();
    },
  };
  return client;
}

export const unavailableText = (port: number) => `QuotaBar feed unavailable on port ${port}; is QuotaBar.app running?`;

function until(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const min = Math.floor((new Date(iso).getTime() - now) / 60_000);
  if (!(min > 0)) return "soon";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}d${h ? `${h}h` : ""}` : h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

// Cursor puts request counts in resetText; "Resets in ..." repeats resetsAt.
const extra = (q: Bucket) => {
  const t = q.resetText?.trim();
  return t && !/^resets?\b/i.test(t) ? t : null;
};

const head = (p: Provider) => `${p.id}${p.tier ? ` (${p.tier})` : ""}`;

/** One line per provider; reset times only for buckets that are not healthy. */
export function compact(providers: Provider[], now = Date.now()): string {
  return providers
    .map((p) => {
      if (p.unavailable) return `${head(p)}: unavailable, ${p.unavailable}`;
      if (!p.quotas.length) return `${head(p)}: no data`;
      const buckets = p.quotas
        .map((q) => {
          const notes = [extra(q), q.status !== "healthy" && `${q.status}, resets ${until(q.resetsAt, now)}`].filter(Boolean);
          return `${q.label.toLowerCase()} ${Math.round(q.percentRemaining)}%${notes.length ? ` (${notes.join("; ")})` : ""}`;
        })
        .join(" · ");
      const throttled = p.throttledUntil ? ` [throttled ${until(p.throttledUntil, now)}, last known]` : "";
      return `${head(p)}: ${buckets}${throttled}`;
    })
    .join("\n");
}

/** Every provider and bucket with reset times and status, for /quota. */
export function full(feed: Feed, now = Date.now()): string {
  const lines: string[] = [];
  for (const p of feed.providers) {
    lines.push(`${p.name ?? p.id}${p.tier ? ` (${p.tier})` : ""}: ${p.unavailable ? `unavailable, ${p.unavailable}` : (p.status ?? "")}`);
    if (p.throttledUntil) lines.push(`  throttled for ${until(p.throttledUntil, now)}, showing last-known data`);
    for (const q of p.quotas) {
      const parts = [`${Math.round(q.percentRemaining)}% left`, extra(q), q.resetsAt && `resets in ${until(q.resetsAt, now)}`, q.status !== "healthy" && q.status];
      lines.push(`  ${q.label}: ${parts.filter(Boolean).join(", ")}`);
    }
  }
  if (feed.disabledProviderIds?.length) lines.push(`Disabled in QuotaBar: ${feed.disabledProviderIds.join(", ")}`);
  return lines.join("\n");
}

type Settings = { get(key: string): unknown };

/** Registers get_quotas and /quota on one client and ties polling to the session. Returns the client for the footer. */
export function registerQuota(pi: ExtensionAPI, settings: Settings, deps: Partial<ClientOptions> = {}): QuotaClient {
  const port = () => settings.get("quotaPort") as number;
  const client = createQuotaClient({ port, refreshMs: () => (settings.get("quotaRefreshSeconds") as number) * 1000, ...deps });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") client.start();
  });
  // Also fires on session switch (reason new/resume/fork) and /reload.
  pi.on("session_shutdown", () => client.stop());

  pi.registerTool({
    name: "get_quotas",
    label: "Get Quotas",
    description: "Remaining subscription quota per AI provider, from QuotaBar.app. Check before routing heavy work to a provider.",
    parameters: {
      type: "object",
      properties: { provider: { type: "string", description: "Provider id, e.g. claude, codex, cursor. Omit for all." } },
    } as never,
    async execute(_id, params: { provider?: string }) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
      const feed = await client.get();
      if (!feed) return text(unavailableText(port()));
      const selected = params.provider ? feed.providers.filter((p) => p.id === params.provider) : feed.providers;
      if (!selected.length) return text(`Unknown provider ${params.provider}; known: ${feed.providers.map((p) => p.id).join(", ")}`);
      return text(compact(selected));
    },
  });

  pi.registerCommand("quota", {
    description: "Show the full QuotaBar feed",
    handler: async (_args, ctx) => {
      const feed = await client.get();
      if (feed) ctx.ui.notify(full(feed), "info");
      else ctx.ui.notify(unavailableText(port()), "warning");
    },
  });

  return client;
}
