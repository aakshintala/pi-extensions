// The rig's one quota client: QuotaBar.app's loopback feed, cached, with
// concurrent requests merged into one fetch. Serves get_quotas and /quota,
// and (ticket #66) the footer. Polls only while a TUI session is active.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";

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
  type Pending = { promise: Promise<Feed | null>; controller: AbortController; timer?: ReturnType<typeof setTimeout>; deadline: number };
  let feed: Feed | null | undefined; // undefined: nothing fetched since creation or the last invalidate
  let fetchedAt = -Infinity;
  let epoch = 0; // bumped by invalidate, so a fetch it aborted never touches the cache
  let inFlight: Pending | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(feed: Feed | null | undefined) => void>();
  const cache = (next: Feed | null | undefined) => {
    feed = next;
    for (const l of listeners) l(next);
  };

  async function run(p: Pending): Promise<Feed | null> {
    const at = epoch;
    try {
      const res = await fetchFn(`http://127.0.0.1:${port()}/quotas`, { signal: p.controller.signal });
      const json = res.ok ? await res.json() : null;
      if (!Array.isArray(json?.providers)) throw new Error("bad feed");
      // An aborted fetch (stop, invalidate) must not repopulate the cache.
      if (p.controller.signal.aborted) return feed ?? null;
      fetchedAt = now();
      cache(json as Feed);
    } catch {
      // A failed refresh keeps the last good feed while it is still fresh.
      if (at === epoch) cache(now() - fetchedAt < refreshMs() ? feed : null);
    } finally {
      timers.clearTimeout(p.timer);
      if (inFlight === p) inFlight = null;
    }
    return feed ?? null;
  }

  // Joiners extend the shared fetch's deadline to the longest caller timeout.
  function arm(p: Pending, timeoutMs: number) {
    const deadline = now() + timeoutMs;
    if (deadline <= p.deadline) return;
    p.deadline = deadline;
    timers.clearTimeout(p.timer);
    p.timer = timers.setTimeout(() => p.controller.abort(), timeoutMs);
  }

  const refresh = () => void client.get({ force: true, timeoutMs: FOOTER_TIMEOUT_MS });

  const client = {
    /** The cached feed while younger than the refresh interval, else one (shared) fetch. Null when QuotaBar is unreachable. */
    get({ force = false, timeoutMs = CALL_TIMEOUT_MS } = {}): Promise<Feed | null> {
      if (!force && feed && now() - fetchedAt < refreshMs()) return Promise.resolve(feed);
      let p = inFlight;
      if (!p) {
        p = inFlight = { controller: new AbortController(), deadline: -Infinity } as Pending;
        arm(p, timeoutMs);
        p.promise = run(p);
      } else arm(p, timeoutMs);
      return p.promise;
    },
    start() {
      if (poll) return;
      refresh();
      poll = timers.setInterval(refresh, refreshMs());
    },
    /** Re-reads the refresh interval; a no-op unless polling. */
    retime() {
      if (!poll) return;
      timers.clearInterval(poll);
      poll = timers.setInterval(refresh, refreshMs());
    },
    /** Drops the cached feed and aborts the in-flight fetch, so the next get fetches afresh. */
    invalidate() {
      epoch++;
      inFlight?.controller.abort();
      inFlight = null;
      fetchedAt = -Infinity;
      cache(undefined);
    },
    /** Calls `listener` with the cached feed each time a fetch settles or invalidate clears it (undefined). */
    onFeed(listener: (feed: Feed | null | undefined) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Idempotent: stops polling and aborts the in-flight fetch. */
    stop() {
      if (poll) timers.clearInterval(poll);
      poll = undefined;
      inFlight?.controller.abort();
      inFlight = null;
    },
  };
  return client;
}

export const unavailableText = (port: number) => `QuotaBar feed unavailable on port ${port}; is QuotaBar.app running?`;

function until(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const min = Math.floor((at - now) / 60_000);
  if (min <= 0) return "soon";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d}d${h ? `${h}h` : ""}` : h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

// Cursor puts request counts in resetText; "Resets in ..." repeats resetsAt.
const extra = (q: Bucket) => {
  const t = q.resetText?.trim();
  return t && !/^resets?\b/i.test(t) ? t : null;
};

const head = (p: Provider) => `${p.id}${p.tier ? ` (${p.tier})` : ""}`;

// get_quotas output stays within ~100 tokens (the audit's char/4 estimate).
export const MAX_TOOL_CHARS = 400;

const clip = (s: string, max = MAX_TOOL_CHARS) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Keeps whole lines while they fit in MAX_TOOL_CHARS, then says how many providers were left out. */
function fit(lines: string[]): string {
  if (lines.join("\n").length <= MAX_TOOL_CHARS) return lines.join("\n");
  const more = (n: number) => `\n+${n} more; pass provider for one`;
  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line].join("\n").length + more(lines.length - kept.length - 1).length > MAX_TOOL_CHARS) break;
    kept.push(line);
  }
  if (!kept.length) kept.push(clip(lines[0], MAX_TOOL_CHARS - more(lines.length - 1).length));
  const left = lines.length - kept.length;
  return kept.join("\n") + (left ? more(left) : "");
}

/** One line per provider, reset times only for unhealthy buckets, within MAX_TOOL_CHARS. */
export function compact(providers: Provider[], now = Date.now()): string {
  const lines = providers
    .map((p) => {
      if (p.unavailable) return `${head(p)}: unavailable, ${p.unavailable}`;
      if (!p.quotas.length) return `${head(p)}: no data`;
      const buckets = p.quotas
        .map((q) => {
          const reset = until(q.resetsAt, now);
          const notes = [extra(q), q.status !== "healthy" && (reset ? `${q.status}, resets ${reset}` : q.status)].filter(Boolean);
          return `${q.label.toLowerCase()} ${Math.round(q.percentRemaining)}%${notes.length ? ` (${notes.join("; ")})` : ""}`;
        })
        .join(" · ");
      const t = until(p.throttledUntil, now);
      const throttled = p.throttledUntil ? ` [throttled${t ? ` ${t}` : ""}, last known]` : "";
      return `${head(p)}: ${buckets}${throttled}`;
    });
  return fit(lines);
}

/** Every provider and bucket with reset times and status, for /quota. */
export function full(feed: Feed, now = Date.now()): string {
  const lines: string[] = [];
  for (const p of feed.providers) {
    const state = p.unavailable ? `unavailable, ${p.unavailable}` : p.status;
    lines.push(`${p.name ?? p.id}${p.tier ? ` (${p.tier})` : ""}${state ? `: ${state}` : ""}`);
    const t = until(p.throttledUntil, now);
    if (p.throttledUntil) lines.push(`  throttled${t ? ` for ${t}` : ""}, showing last-known data`);
    for (const q of p.quotas) {
      const text = q.resetText?.trim();
      const at = until(q.resetsAt, now);
      const reset = text && /^resets?\b/i.test(text) ? text : at && `resets in ${at}`;
      const parts = [`${Math.round(q.percentRemaining)}% left`, extra(q), reset, q.status];
      lines.push(`  ${q.label}: ${parts.filter(Boolean).join(", ")}`);
    }
  }
  if (feed.disabledProviderIds?.length) lines.push(`Disabled in QuotaBar: ${feed.disabledProviderIds.join(", ")}`);
  return lines.join("\n");
}

type Settings = { get(key: string): unknown; onChange?(listener: (key: string) => void): () => void };

/** Registers get_quotas and /quota on one client and ties polling to the session. Returns the client for the footer. */
export function registerQuota(pi: ExtensionAPI, settings: Settings, deps: Partial<ClientOptions> = {}): QuotaClient {
  const port = () => settings.get("quotaPort") as number;
  const client = createQuotaClient({ port, refreshMs: () => (settings.get("quotaRefreshSeconds") as number) * 1000, ...deps });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") client.start();
  });
  // Sections are shared across sessions (#95): unsubscribe, or every ended session leaves a listener.
  const off = settings.onChange?.((key) => {
    if (key === "quotaRefreshSeconds") client.retime();
    if (key === "quotaPort") client.invalidate();
  });
  // Also fires on session switch (reason new/resume/fork) and /reload. Idempotent.
  pi.on("session_shutdown", () => {
    client.stop();
    off?.();
  });

  pi.registerTool({
    name: "get_quotas",
    label: "Get Quotas",
    description:
      "Remaining subscription quota per AI provider, from QuotaBar.app. Returns one line per provider: percent left per bucket, plus status and reset time for unhealthy buckets.",
    parameters: {
      type: "object",
      properties: { provider: { type: "string", description: "Provider id, e.g. claude, codex, cursor. Omit for all." } },
    } as never,
    ...toolRenderers({
      title: "GetQuotas",
      arg: (a: { provider?: string }) => a.provider ?? "",
      result: (r, _a, _e, theme) => ({ summary: "Checked quotas", body: resultText(r).split("\n").map((l) => theme.fg("toolOutput", l)) }),
      summary: { verb: "checked", many: "quotas" },
    }),
    async execute(_id, params: { provider?: string }) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
      const feed = await client.get();
      if (!feed) return text(unavailableText(port()));
      const selected = params.provider ? feed.providers.filter((p) => p.id.toLowerCase() === params.provider!.toLowerCase()) : feed.providers;
      if (!selected.length) return text(clip(`Unknown provider ${params.provider}; known: ${feed.providers.map((p) => p.id).join(", ")}`));
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
