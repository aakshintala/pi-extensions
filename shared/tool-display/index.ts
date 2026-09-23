// Shared tool-display style (spec #40): Claude Code-style call lines, collapsed
// results, error lines and capped unified diffs. Every rig tool and the built-in
// decorator render through here, and runs of calls collapse into one group summary.
import { generateUnifiedPatch, keyText, type Theme, type ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

/** Body lines a collapsed result shows before its "+N lines" marker. */
export const COLLAPSED_LINES = 4;
/** Most body lines an expanded result shows. */
export const EXPANDED_LINES = 200;
/** Edits larger than this (old + new characters) are not diffed. */
export const DIFF_MAX_CHARS = 100_000;

const CALL = "⏺";
const RESULT = "⎿";
const PAD = " "; // matches Pi's one-column message padding
const BODY = PAD + "     "; // body text lines up under the summary text

export type CallStatus = "pending" | "done" | "error";

/** A component whose lines are computed for the width it is given. */
export const lines = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });

/** `⏺ Title(arg)` on one line, the bullet coloured by status. */
export function callLine(theme: Theme, status: CallStatus, title: string, arg: string, width: number): string {
  const bullet = theme.fg(status === "error" ? "error" : status === "done" ? "success" : "muted", CALL);
  const text = `${PAD}${bullet} ${theme.fg("toolTitle", theme.bold(title))}${arg ? theme.fg("muted", `(${arg})`) : ""}`;
  return truncateToWidth(text, width);
}

/**
 * `⎿ summary` followed by body lines, each truncated to one row. Collapsed, the body
 * stops after COLLAPSED_LINES with a marker naming how many lines are hidden.
 */
export function resultLines(theme: Theme, summary: string, body: string[], expanded: boolean, width: number): string[] {
  const out = [truncateToWidth(`${PAD}  ${theme.fg("dim", RESULT)}  ${summary}`, width)];
  const shown = body.slice(0, expanded ? EXPANDED_LINES : COLLAPSED_LINES);
  for (const l of shown) out.push(truncateToWidth(BODY + l, width));
  const hidden = body.length - shown.length;
  if (hidden > 0) {
    const hint = expanded ? "" : ` (${keyText("app.tools.expand") || "ctrl+o"} to expand)`;
    out.push(truncateToWidth(BODY + theme.fg("muted", `… +${hidden} ${plural(hidden, "line")}${hint}`), width));
  }
  return out;
}

/** `⎿ Error: …` in the error colour, wrapped to the width; collapsed after COLLAPSED_LINES rows. */
export function errorLines(theme: Theme, message: string, expanded: boolean, width: number): string[] {
  const text = message.trim() || "failed";
  const wrapped = `Error: ${text}`.split("\n").flatMap((l) => wrapTextWithAnsi(l, Math.max(1, width - BODY.length)));
  const [first, ...rest] = wrapped.map((l) => theme.fg("error", l));
  return resultLines(theme, first, rest, expanded, width);
}

export interface Diff {
  /** Unified diff body lines: `+added`, `-removed`, ` context`, or `@@` between hunks. */
  lines: string[];
  added: number;
  removed: number;
  /** True when the input was over DIFF_MAX_CHARS and no diff was computed. */
  tooLarge: boolean;
}

/** Line diff of each old/new pair, computed from text alone (no file reads). */
export function unifiedDiff(pairs: { oldText: string; newText: string }[]): Diff {
  const size = pairs.reduce((n, p) => n + p.oldText.length + p.newText.length, 0);
  if (size > DIFF_MAX_CHARS) return { lines: [], added: 0, removed: 0, tooLarge: true };
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  for (const { oldText, newText } of pairs) {
    const patch = generateUnifiedPatch("", withEol(oldText), withEol(newText), 2).split("\n").slice(2, -1);
    for (const l of patch) {
      if (l.startsWith("@@")) {
        if (out.length > 0) out.push("@@");
      } else if (!l.startsWith("\\")) {
        out.push(l);
        if (l[0] === "+") added++;
        else if (l[0] === "-") removed++;
      }
    }
  }
  return { lines: out, added, removed, tooLarge: false };
}

/** Diff lines in the theme's diff colours, hunk breaks as a dim `⋯`. */
export const diffBody = (theme: Theme, diff: Diff): string[] =>
  diff.lines.map((l) =>
    l === "@@"
      ? theme.fg("dim", "⋯")
      : theme.fg(l[0] === "+" ? "toolDiffAdded" : l[0] === "-" ? "toolDiffRemoved" : "toolDiffContext", l),
  );

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Text of a tool result's text blocks. */
export const resultText = (result: unknown): string => {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text")
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
};

/** What one tool contributes: a title, the call's argument, and its result summary and body. */
export interface ToolStyle<Args = any, Result = any> {
  title: string;
  arg(args: Args, cwd: string): string;
  result(result: Result, args: Args, expanded: boolean, theme: Theme): { summary: string; body: string[] };
  /** How the tool counts in a group summary. Without it, calls are never grouped. */
  summary?: Summary<Args>;
}

/**
 * renderShell/renderCall/renderResult for a tool, drawn in the shared style. With
 * `renderShell: "self"` the call and result own every row, so a group member can
 * render zero lines.
 */
export function toolRenderers<Args, Result>(style: ToolStyle<Args, Result>) {
  if (style.summary) S.summaries.set(style.summary.tool, style.summary);
  return {
    renderShell: "self" as const,
    renderCall(args: Args, theme: Theme, context: ToolRenderContext): Component {
      const c = call(context.toolCallId);
      c.invalidate = context.invalidate;
      const g = c.group;
      const own = (w: number) => {
        const state = g ? stateOf(c) : context.isError ? "error" : context.isPartial ? "pending" : "done";
        const status: CallStatus = state === "cancelled" ? "error" : state;
        return callLine(theme, status, style.title, style.arg(args ?? ({} as Args), context.cwd), w);
      };
      if (!g) return lines((w) => [own(w)]);
      const open = isOpen(g, context);
      const summary = !open && g.ids[0] === context.toolCallId;
      const shown = open || stateOf(c) === "error";
      return clickable(g, lines((w) => [...(summary ? [summaryLine(theme, g, w)] : []), ...(shown ? [own(w)] : [])]));
    },
    renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext): Component {
      const c = S.calls.get(context.toolCallId);
      const g = c?.group;
      if (options.isPartial || (g && !isOpen(g, context) && stateOf(c!) !== "error")) return lines(() => []);
      let out: Component;
      if (context.isError) {
        const message = resultText(result).replaceAll(`${context.cwd}/`, "");
        out = lines((w) => errorLines(theme, message, options.expanded, w));
      } else {
        const { summary, body } = style.result(result, context.args ?? {}, options.expanded, theme);
        out = lines((w) => resultLines(theme, summary, body, options.expanded, w));
      }
      return g ? clickable(g, out) : out;
    },
  };
}

// ---- Groups (#56) ----
// A run of consecutive calls to tools with a summary, in one assistant message, is a
// group. Its first call draws one summary line and the others draw nothing, until
// Ctrl+O (context.expanded) or a click on the group opens it. Failed calls always
// show. Groups come from the message itself (trackMessage), so a transcript rebuilt
// from saved messages groups the same way as the live chat.

/** How a tool counts in a group summary: `verb N one|many`, or `verb many` without `one`. */
export interface Summary<Args = any> {
  /** The tool's registered name. */
  tool: string;
  verb: string;
  one?: string;
  many?: string;
  /** Lines a finished call added and removed, summed as `+a −r`. */
  lines?(args: Args): { added: number; removed: number } | undefined;
}

export type CallState = "pending" | "done" | "error" | "cancelled";

interface Group {
  ids: string[];
  expanded: boolean;
  /** The turn was aborted: calls still pending are cancelled. */
  ended: boolean;
}
interface Call {
  status: Exclude<CallState, "cancelled">;
  summary?: Summary;
  args?: any;
  group?: Group;
  invalidate?: () => void;
}

// One store per process: every extension that imports this module shares the groups.
const S: { summaries: Map<string, Summary>; calls: Map<string, Call>; frame: number; timer?: ReturnType<typeof setInterval> } =
  ((globalThis as any)[Symbol.for("pi-rig.tool-groups")] ??= { summaries: new Map(), calls: new Map(), frame: 0 });

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = 80;

const call = (id: string): Call => S.calls.get(id) ?? S.calls.set(id, { status: "pending" }).get(id)!;
const stateOf = (c: Call): CallState => (c.status === "pending" && c.group?.ended ? "cancelled" : c.status);
const isOpen = (g: Group, context: ToolRenderContext) => context.expanded || g.expanded;
// A chat can still draw a group after resetGroups (session switch) forgot its calls.
const members = (g: Group) => g.ids.flatMap((id) => S.calls.get(id) ?? []);
const running = (g: Group) => members(g).some((c) => stateOf(c) === "pending");
const refresh = (g: Group) => members(g).forEach((c) => c.invalidate?.());

/** Clicking any row of a group opens or closes that group only. */
const clickable = (g: Group, child: Component): Component =>
  new MouseRegion(child, (e) => {
    if (e.type !== "click" || e.button !== "left") return undefined;
    g.expanded = !g.expanded;
    refresh(g);
    return { handled: true };
  });

/** Registers the groups in an assistant message (call on every update and at its end). */
export function trackMessage(message: any): void {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
  const runs: any[][] = [[]];
  for (const b of message.content) {
    if (b?.type === "toolCall" && S.summaries.has(b.name)) runs.at(-1)!.push(b);
    else if (b?.type === "toolCall" || (b?.type === "text" && b.text?.trim())) runs.push([]);
  }
  const ended = message.stopReason === "aborted" || message.stopReason === "error";
  for (const run of runs.filter((r) => r.length)) {
    const g = call(run[0].id).group ?? { ids: [], expanded: false, ended: false };
    const ids = run.map((b) => b.id);
    const changed = ids.join() !== g.ids.join() || ended !== g.ended;
    Object.assign(g, { ids, ended: g.ended || ended });
    for (const b of run) Object.assign(call(b.id), { group: g, summary: S.summaries.get(b.name), args: b.arguments });
    if (changed) refresh(g);
  }
}

/** Records a call's result. */
export function settle(id: string, status: Exclude<CallState, "pending">): void {
  const c = S.calls.get(id);
  if (!c?.group) return;
  if (status === "cancelled") c.group.ended = true;
  else c.status = status;
  refresh(c.group);
}

/** The turn is over: calls with no result are cancelled. */
export function endRun(): void {
  for (const g of new Set([...S.calls.values()].map((c) => c.group))) {
    if (g && running(g)) {
      g.ended = true;
      refresh(g);
    }
  }
}

/** Forgets every group and stops the spinner (session start and shutdown). */
export function resetGroups(): void {
  stopSpinner();
  S.calls.clear();
}

// One timer for every running group; each tick redraws only those groups' summary lines.
function spin() {
  S.timer ??= setInterval(() => {
    S.frame++;
    const live = new Set([...S.calls.values()].map((c) => c.group).filter((g) => g && running(g)));
    for (const g of live) S.calls.get(g!.ids[0])?.invalidate?.();
    if (live.size === 0) stopSpinner();
  }, SPIN_MS);
}
const stopSpinner = () => {
  clearInterval(S.timer);
  S.timer = undefined;
};

function summaryLine(theme: Theme, g: Group, width: number): string {
  const calls = members(g).map((c) => ({ summary: c.summary!, status: stateOf(c), args: c.args }));
  const live = calls.some((c) => c.status === "pending");
  if (live) spin();
  const bad = calls.some((c) => c.status === "error" || c.status === "cancelled");
  const bullet = live ? theme.fg("muted", SPINNER[S.frame % SPINNER.length]) : theme.fg(bad ? "error" : "success", CALL);
  return truncateToWidth(`${PAD}${bullet} ${summaryText(theme, calls)}`, width);
}

const lineTotals = new WeakMap<object, { added: number; removed: number } | undefined>();

/**
 * A group's summary: "Read 3 files, edited 2 files +442 −12" in the dim colour, with
 * "N failed" and "N cancelled" in the error colour. `thought` starts it with "thought ·".
 */
export function summaryText(theme: Theme, calls: { summary: Summary; status: CallState; args?: any }[], thought = false): string {
  const kinds = new Map<string, { s: Summary; n: number; added: number; removed: number }>();
  let failed = 0;
  let cancelled = 0;
  for (const { summary: s, status, args } of calls) {
    if (status === "error") failed++;
    else if (status === "cancelled") cancelled++;
    else {
      const key = `${s.verb}|${s.one}|${s.many}`;
      const k = kinds.get(key) ?? kinds.set(key, { s, n: 0, added: 0, removed: 0 }).get(key)!;
      k.n++;
      if (status === "done" && s.lines && args && typeof args === "object") {
        if (!lineTotals.has(args)) lineTotals.set(args, s.lines(args));
        k.added += lineTotals.get(args)?.added ?? 0;
        k.removed += lineTotals.get(args)?.removed ?? 0;
      }
    }
  }
  let text = [...kinds.values()]
    .map(({ s, n, added, removed }) =>
      [s.one ? `${s.verb} ${n} ${plural(n, s.one, s.many)}` : `${s.verb} ${s.many ?? ""}`.trim(), added ? `+${added}` : "", removed ? `−${removed}` : ""]
        .filter(Boolean)
        .join(" "),
    )
    .join(", ");
  if (!thought) text = text.charAt(0).toUpperCase() + text.slice(1);
  const sep = theme.fg("dim", " · ");
  const parts = [thought ? theme.fg("dim", "thought") : "", text ? theme.fg("dim", text) : ""];
  if (failed) parts.push(theme.fg("error", `${failed} failed`));
  if (cancelled) parts.push(theme.fg("error", `${cancelled} cancelled`));
  return parts.filter(Boolean).join(sep);
}

/** A path shown relative to the working directory when it is inside it. */
export function shortPath(path: unknown, cwd: string): string {
  if (typeof path !== "string") return "";
  return cwd && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

const withEol = (s: string) => (s === "" || s.endsWith("\n") ? s : s + "\n");
