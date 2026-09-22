import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Display bundle (issue #9, part of #1). One status extension plus the
// condensed quota/usage/context/stamp/tool displays as derived state.
//
// Honest-state rule (PR #20 lesson): the footer renders only measured
// values read from ctx at event time. Segments without a measured source
// are omitted, never filled with fixed strings. Git branch and quota
// headroom have no measured source on ExtensionContext, so the live
// status omits them; formatGitBranch/formatQuota below accept measured
// values for when a future caller supplies them, and report
// "not yet implemented" only when asked to render without data.
//
// No module-global per-session state (PR #20 repair): every refresh
// derives synchronously from the ctx it receives, so interleaved
// sessions can never share values. No timers, processes, or sockets.

const SLOT = "display";

// Compact counts: 999 -> "999", 1500 -> "1.5k".
export function compactCount(n: unknown): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  if (n < 1000) return `${Math.floor(n)}`;
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

export interface UsageTotals {
  input: number;
  output: number;
  cost: number;
  turns: number;
}

// Session usage totals derived from the active branch. Defensive: skips
// entries without a measurable assistant usage payload.
export function summarizeUsage(branch: unknown): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cost: 0, turns: 0 };
  if (!Array.isArray(branch)) return totals;
  for (const entry of branch) {
    const message = (entry as { message?: unknown })?.message as
      | { role?: unknown; usage?: { input?: unknown; output?: unknown; cost?: unknown } }
      | undefined;
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (usage == null || typeof usage !== "object") continue;
    totals.turns += 1;
    if (typeof usage.input === "number" && Number.isFinite(usage.input)) totals.input += usage.input;
    if (typeof usage.output === "number" && Number.isFinite(usage.output)) totals.output += usage.output;
    const cost = usage.cost;
    const total = typeof cost === "number" ? cost : (cost as { total?: unknown })?.total;
    if (typeof total === "number" && Number.isFinite(total)) totals.cost += total;
  }
  return totals;
}

// "provider/id", or undefined when no model is measured.
export function formatModel(model: unknown): string | undefined {
  const m = model as { provider?: unknown; id?: unknown } | undefined;
  if (typeof m?.id !== "string" || m.id.length === 0) return undefined;
  return typeof m.provider === "string" && m.provider.length > 0 ? `${m.provider}/${m.id}` : m.id;
}

// "12.5k tokens (6%)", or undefined when tokens are unknown.
export function formatContextUsage(usage: unknown): string | undefined {
  const u = usage as { tokens?: unknown; percent?: unknown } | undefined;
  if (typeof u?.tokens !== "number" || !Number.isFinite(u.tokens)) return undefined;
  const tokens = compactCount(u.tokens) ?? `${u.tokens}`;
  const pct = typeof u.percent === "number" && Number.isFinite(u.percent) ? ` (${u.percent}%)` : "";
  return `${tokens} tokens${pct}`;
}

// Quota headroom from measured numbers. Without data there is nothing
// honest to render: callers omit the segment; direct calls are told so.
export function formatQuota(quota: unknown): string | undefined {
  if (quota == null) return undefined;
  const q = quota as { remaining?: unknown; limit?: unknown };
  const remaining = typeof q.remaining === "number" && Number.isFinite(q.remaining) ? compactCount(q.remaining) : undefined;
  const limit = typeof q.limit === "number" && Number.isFinite(q.limit) ? compactCount(q.limit) : undefined;
  if (remaining === undefined && limit === undefined) return "quota: not yet implemented";
  return `quota ${remaining ?? "?"}${limit !== undefined ? `/${limit}` : ""}`;
}

// Git branch segment, or "" when no branch is measured.
export function formatGitBranch(branch: unknown): string {
  return typeof branch === "string" && branch.length > 0 ? `(${branch})` : "";
}

// Condensed stamp for one session entry. Unknown shapes are labeled,
// never rendered as a specific fact.
export function formatStamp(entry: unknown): string {
  const e = entry as { type?: unknown; timestamp?: unknown } | undefined;
  const type = typeof e?.type === "string" && e.type.length > 0 ? e.type : "unknown entry";
  if (typeof e?.timestamp === "number" && Number.isFinite(e.timestamp)) {
    return `${type} · ${new Date(e.timestamp).toLocaleTimeString()}`;
  }
  return type;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Condensed one-line tool summary. Known tools name their target;
// unknown tools render their name only (never a raw args dump).
export function formatToolCall(name: unknown, args: unknown): string {
  if (typeof name !== "string" || name.length === 0) return "unknown tool";
  const a = (args ?? {}) as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
  switch (name) {
    case "read": {
      if (!path) return "read";
      const range =
        a.offset != null || a.limit != null ? ` (${[a.offset ?? "…", a.limit ?? "…"].join(",")})` : "";
      return `read ${path}${range}`;
    }
    case "bash":
      return typeof a.command === "string" && a.command.length > 0 ? `$ ${truncate(a.command, 80)}` : "bash";
    case "edit":
    case "write":
      return path ? `${name} ${path}` : name;
    default:
      return name;
  }
}

// Joins measured segments, dropping empties. Returns undefined when
// nothing was measured, so callers can leave the slot untouched.
export function buildStatusLine(segments: Array<string | undefined>): string | undefined {
  const parts = segments.filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// Derives the status line from live ctx reads only.
export function deriveStatus(ctx: {
  model?: unknown;
  getContextUsage?: () => unknown;
  sessionManager?: { getBranch?: () => unknown };
}): string | undefined {
  const model = formatModel(safe(() => (ctx as { model?: unknown }).model));
  const context = formatContextUsage(safe(() => ctx.getContextUsage?.()));
  const branch = safe(() => ctx.sessionManager?.getBranch?.());
  const totals = summarizeUsage(branch);
  const input = compactCount(totals.input);
  const usage =
    totals.turns > 0 && input !== undefined
      ? `↑${input} ↓${compactCount(totals.output) ?? 0} $${totals.cost.toFixed(2)}`
      : undefined;
  return buildStatusLine([model, context, usage]);
}

function refresh(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): void {
  const line = safe(() => deriveStatus(ctx as unknown as Parameters<typeof deriveStatus>[0]));
  if (line !== undefined) safe(() => (ctx as { ui: { setStatus: (k: string, t: string) => void } }).ui.setStatus(SLOT, line));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    refresh(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent: clearing an already-cleared slot is a no-op.
    safe(() => ctx.ui.setStatus(SLOT, undefined));
  });
}
