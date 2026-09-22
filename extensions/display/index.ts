import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Display extension (issue #9): one status extension rendering measured
// model, git, context, quota, usage, tool, and stamp state in the footer slot.
// Every segment needs a measured value; unmeasured segments are omitted and
// a fully-unmeasured refresh clears the slot. No timers, no watchers.

const SLOT = "display";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Compact counts: 999 -> "999", 1500 -> "1.5k".
export function compactCount(n: unknown): string | undefined {
  if (!isNum(n)) return undefined;
  if (n < 1000) return `${Math.floor(n)}`;
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

export interface UsageTotals {
  input: number;
  output: number;
  // Undefined until some assistant payload reports a cost: never $0.00 invented.
  cost: number | undefined;
  turns: number;
}

// Session usage totals derived from the active branch. Defensive: skips
// entries without a measurable assistant usage payload.
export function summarizeUsage(branch: unknown): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cost: undefined, turns: 0 };
  if (!Array.isArray(branch)) return totals;
  for (const entry of branch) {
    const message = (entry as { message?: unknown })?.message as
      | { role?: unknown; usage?: { input?: unknown; output?: unknown; cost?: unknown } }
      | undefined;
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (usage == null || typeof usage !== "object") continue;
    totals.turns += 1;
    if (isNum(usage.input)) totals.input += usage.input;
    if (isNum(usage.output)) totals.output += usage.output;
    const cost = usage.cost;
    const total = typeof cost === "number" ? cost : (cost as { total?: unknown })?.total;
    if (isNum(total)) totals.cost = (totals.cost ?? 0) + total;
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
  const u = (usage ?? {}) as { tokens?: unknown; percent?: unknown };
  if (!isNum(u.tokens)) return undefined;
  const pct = isNum(u.percent) ? ` (${Math.round(u.percent)}%)` : "";
  return `${compactCount(u.tokens)} tokens${pct}`;
}

// Context-window headroom from measured numbers. Remaining unmeasured
// means nothing honest to render, so callers omit the segment.
export function formatQuota(quota: unknown): string | undefined {
  if (quota == null) return undefined;
  const q = quota as { remaining?: unknown; limit?: unknown };
  if (!isNum(q.remaining)) return undefined;
  const limit = isNum(q.limit) ? `/${compactCount(q.limit)}` : "";
  return `quota ${compactCount(q.remaining)}${limit}`;
}

// Measured branch read off ctx.cwd: parses .git/HEAD, following the .git
// gitdir pointer in worktrees. "detached" matches the built-in footer;
// undefined when outside a repo or unreadable.
export function readGitBranch(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  let dir = join(cwd, ".git");
  const pointer = readText(dir);
  const target = pointer != null ? /^gitdir:\s*(.+?)\s*$/.exec(pointer)?.[1] : undefined;
  if (target) dir = resolve(cwd, target);
  const head = (readText(join(dir, "HEAD")) ?? "").trim();
  const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head)?.[1];
  if (ref) return ref;
  return head.length >= 4 && /^[0-9a-fA-F]+$/.test(head) ? "detached" : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Git branch segment, or undefined when no branch is measured.
export function formatGitBranch(branch: unknown): string | undefined {
  return typeof branch === "string" && branch.length > 0 ? `(${branch})` : undefined;
}

// Condensed stamp for one session entry. Unknown shapes are labeled,
// never rendered as a specific fact. Accepts the ISO-string timestamps
// session entries carry as well as epoch millis.
export function formatStamp(entry: unknown): string {
  const e = (entry ?? {}) as { type?: unknown; timestamp?: unknown };
  const type = typeof e.type === "string" && e.type.length > 0 ? e.type : "unknown entry";
  const t = e.timestamp;
  const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? `${type} · ${new Date(ms).toLocaleTimeString()}` : type;
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
// nothing was measured, so the slot can be cleared instead of going stale.
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

// Context-window headroom from measured usage: remaining needs both
// tokens and window, so a post-compaction null tokens read omits quota.
function quotaFromUsage(usage: unknown): { remaining: unknown; limit: unknown } {
  const u = (usage ?? {}) as { tokens?: unknown; contextWindow?: unknown };
  return {
    remaining:
      isNum(u.tokens) && isNum(u.contextWindow) ? Math.max(0, u.contextWindow - u.tokens) : undefined,
    limit: u.contextWindow,
  };
}

// Derives the status line from live ctx reads plus the triggering tool
// event, if any. Tool renders transiently from its hook payload; stamp
// renders the latest branch entry. Performance has no per-turn measured
// source on ExtensionContext (core timings are startup-only), so it stays
// out until one exists (deferral note on #9).
export function deriveStatus(ctx: ExtensionContext, tool?: { name: unknown; args: unknown }): string | undefined {
  const model = formatModel(safe(() => ctx.model));
  const git = formatGitBranch(safe(() => readGitBranch(ctx.cwd)));
  const contextUsage = safe(() => ctx.getContextUsage?.());
  const context = formatContextUsage(contextUsage);
  const quota = formatQuota(quotaFromUsage(contextUsage));
  const branch = safe(() => ctx.sessionManager?.getBranch?.());
  const totals = summarizeUsage(branch);
  const usage =
    totals.turns > 0
      ? `↑${compactCount(totals.input)} ↓${compactCount(totals.output)}${
          totals.cost !== undefined ? ` $${totals.cost.toFixed(2)}` : ""
        }`
      : undefined;
  const toolLine = tool === undefined ? undefined : formatToolCall(tool.name, tool.args);
  const stamp =
    Array.isArray(branch) && branch.length > 0 ? formatStamp(branch[branch.length - 1]) : undefined;
  return buildStatusLine([model, git, context, quota, usage, toolLine, stamp]);
}

function refresh(ctx: ExtensionContext, tool?: { name: unknown; args: unknown }): void {
  const line = safe(() => deriveStatus(ctx, tool));
  // Always set: undefined clears, so a fully-unmeasured refresh never
  // leaves a stale footer behind.
  safe(() => ctx.ui.setStatus(SLOT, line));
}

// Plain re-derives: session_start also picks up the git read, turn_end the
// usage totals, message_end the latest stamp, and the compaction pair the
// post-compaction context (Pi fires session_compact/failed; verified in
// ExtensionAPI — no gap).
const PLAIN_EVENTS = [
  "session_start",
  "model_select",
  "turn_end",
  "message_end",
  "session_compact",
  "session_compact_failed",
] as const;

// Tool hooks carry their own payload for the transient tool segment:
// tool_call reports input, the execution pair reports args.
const TOOL_EVENTS = ["tool_call", "tool_execution_start", "tool_execution_end"] as const;

export default function (pi: ExtensionAPI) {
  for (const event of PLAIN_EVENTS) {
    pi.on(event, async (_event, ctx) => {
      refresh(ctx);
    });
  }
  for (const event of TOOL_EVENTS) {
    pi.on(event, async (event, ctx) => {
      const e = event as { toolName?: unknown; args?: unknown; input?: unknown };
      refresh(ctx, { name: e.toolName, args: e.args ?? e.input });
    });
  }
  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent: clearing an already-cleared slot is a no-op.
    safe(() => ctx.ui.setStatus(SLOT, undefined));
  });
}
