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
  return {
    renderShell: "self" as const,
    renderCall(args: Args, theme: Theme, context: ToolRenderContext): Component {
      const groups = sessionOf(context.toolCallId, context.args ?? args);
      const c = groups?.describe(context.toolCallId, style.summary, context.invalidate);
      const g = c && groups!.group(context.toolCallId);
      const own = (w: number) => {
        const state = c ? c.state() : context.isError ? "error" : context.isPartial ? "pending" : "done";
        const status: CallStatus = state === "cancelled" ? "error" : state;
        return callLine(theme, status, style.title, style.arg(args ?? ({} as Args), context.cwd), w);
      };
      if (!g) return lines((w) => [own(w)]);
      const open = context.expanded || g.open;
      const summary = !open && g.calls[0] === c;
      const shown = open || c!.alwaysShown();
      return clickable(g, lines((w) => [...(summary ? [summaryLine(theme, g, w)] : []), ...(shown ? [own(w)] : [])]));
    },
    renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext): Component {
      const groups = sessionOf(context.toolCallId, context.args);
      const g = groups?.group(context.toolCallId);
      const c = g?.calls.find((m) => m.id === context.toolCallId);
      if (options.isPartial || (g && !context.expanded && !g.open && !c!.alwaysShown())) return lines(() => []);
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
// Consecutive calls to tools with a summary, in one assistant message, form a group.
// Its first call draws one summary line and the others draw nothing, until Ctrl+O
// (context.expanded) or a click on the group opens it. Failed calls and calls with
// images always show. Groups come from the message itself, so a transcript rebuilt
// from saved messages groups the same way as the live chat.
//
// Each session owns one ToolGroups (its extension creates it and drives it from Pi's
// events and its own spinner timer). Renderers find a call's session through a
// process-wide index of call ids, which each session adds to and removes from.

/** How a tool counts in a group summary: `verb N one|many`, or `verb many` without `one`. */
export interface Summary<Args = any> {
  verb: string;
  one?: string;
  many?: string;
  /** Lines a finished call added and removed, summed as `+a −r`. */
  lines?(args: Args): { added: number; removed: number } | undefined;
}

export type CallState = "pending" | "done" | "error" | "cancelled";
type Outcome = Exclude<CallState, "pending">;

/**
 * How a finished call ended, from data Pi saves with it: Pi's own abort result
 * ("Operation aborted") is a cancel, any other error a failure.
 */
export const outcomeOf = (isError: boolean, result: unknown): Outcome =>
  !isError ? "done" : resultText(result).trim() === "Operation aborted" ? "cancelled" : "error";

const hasImage = (result: unknown) =>
  Array.isArray((result as any)?.content) && (result as any).content.some((c: any) => c?.type === "image");

interface Run {
  ids: string[];
  /** Set when the message or its turn ended: what a call with no result counts as. */
  ended?: "cancelled" | "error";
}

class Call {
  status: CallState = "pending";
  image = false;
  open = false;
  summary?: Summary;
  invalidate?: () => void;
  id: string;
  run: Run;
  args: unknown;
  constructor(id: string, run: Run, args: unknown) {
    this.id = id;
    this.run = run;
    this.args = args;
  }
  state(): CallState {
    return this.status === "pending" && this.run.ended ? this.run.ended : this.status;
  }
  /** Failures show under the summary; so do images, which Pi draws outside the renderers. */
  alwaysShown() {
    return this.state() === "error" || this.image;
  }
}

interface Group {
  session: ToolGroups;
  calls: Call[];
  open: boolean;
}

// Call id → the sessions that have it. Ids can repeat across sessions (some providers
// build them from the clock), so each session adds and removes only itself, and a
// renderer picks the session whose call has its arguments object.
const INDEX: Map<string, ToolGroups[]> = ((globalThis as any)[Symbol.for("pi-rig.tool-groups")] ??= new Map());
const sessionOf = (id: string, args: unknown) => {
  const owners = INDEX.get(id);
  return owners && (owners.find((g) => g.argsOf(id) === args) ?? owners[0]);
};
const unindex = (id: string, groups: ToolGroups) => {
  const rest = INDEX.get(id)?.filter((g) => g !== groups) ?? [];
  if (rest.length) INDEX.set(id, rest);
  else INDEX.delete(id);
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One session's tool groups. */
export class ToolGroups {
  private calls = new Map<string, Call>();
  /** Results that arrived before their call was registered. */
  private early = new Map<string, { outcome: Outcome; image: boolean }>();
  frame = 0;

  /** Registers the groups in an assistant message (call on every update and at its end). */
  track(message: any): void {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const runs: any[][] = [[]];
    for (const b of message.content) {
      if (b?.type === "toolCall" && typeof b.id === "string") runs.at(-1)!.push(b);
      else if (b?.type === "text" && b.text?.trim()) runs.push([]);
    }
    const ended = message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : undefined;
    for (const blocks of runs.filter((r) => r.length)) {
      const ids = blocks.map((b) => b.id);
      const old = this.calls.get(ids[0])?.run;
      const run: Run = old ?? { ids: [] };
      // A call revised out of the message leaves its group.
      for (const id of run.ids) if (!ids.includes(id)) this.forget(id);
      const changed = ids.join() !== run.ids.join() || (ended && !run.ended);
      run.ids = ids;
      run.ended ??= ended;
      for (const b of blocks) {
        const c = this.calls.get(b.id);
        if (c) Object.assign(c, { run, args: b.arguments });
        else this.add(new Call(b.id, run, b.arguments));
      }
      if (changed) this.refresh(run);
    }
  }

  /** Records a call's result (Pi's tool_execution_end, or a saved toolResult message). */
  settle(id: string, isError: boolean, result: unknown): void {
    const outcome = { outcome: outcomeOf(isError, result), image: hasImage(result) };
    const c = this.calls.get(id);
    if (!c) return void this.early.set(id, outcome);
    Object.assign(c, { status: outcome.outcome, image: outcome.image });
    this.refresh(c.run);
  }

  /** The turn is over: calls still without a result are cancelled. */
  endRun(): void {
    for (const run of new Set([...this.calls.values()].map((c) => c.run))) {
      if (!run.ended && run.ids.some((id) => this.calls.get(id)?.status === "pending")) {
        run.ended = "cancelled";
        this.refresh(run);
      }
    }
  }

  /** Forgets every call (session start and shutdown). */
  reset(): void {
    for (const id of this.calls.keys()) unindex(id, this);
    this.calls.clear();
    this.early.clear();
  }

  /** Advances the spinner and redraws the summary line of each running group. */
  tick(): void {
    this.frame++;
    for (const run of new Set([...this.calls.values()].map((c) => c.run))) {
      if (run.ended || !run.ids.some((id) => this.calls.get(id)?.status === "pending")) continue;
      for (const id of run.ids) {
        const g = this.group(id);
        if (g && g.calls[0].id === id && g.calls.some((c) => c.state() === "pending")) g.calls[0].invalidate?.();
      }
    }
  }

  /** Called by a renderer: records the call's summary and redraw hook. */
  describe(id: string, summary: Summary | undefined, invalidate: () => void): Call | undefined {
    const c = this.calls.get(id);
    if (!c) return undefined;
    c.invalidate = invalidate;
    if (summary && !c.summary) {
      c.summary = summary;
      // The call may join the group before it: redraw the others (not itself, mid-render).
      for (const m of this.group(id)?.calls ?? []) if (m !== c) m.invalidate?.();
    }
    return c;
  }

  /**
   * The call's group: the calls around it in its run that have a summary. Pi renders
   * calls in message order, so every call before this one has already described itself.
   */
  group(id: string): Group | undefined {
    const c = this.calls.get(id);
    if (!c?.summary) return undefined;
    const ids = c.run.ids;
    const has = (i: number) => !!this.calls.get(ids[i])?.summary;
    let start = ids.indexOf(id);
    let end = start;
    while (start > 0 && has(start - 1)) start--;
    while (end < ids.length - 1 && has(end + 1)) end++;
    const calls = ids.slice(start, end + 1).map((i) => this.calls.get(i)!);
    return { session: this, calls, open: calls[0].open };
  }

  /** The arguments this session holds for a call (how a renderer tells sessions apart). */
  argsOf(id: string): unknown {
    return this.calls.get(id)?.args;
  }

  /** Opens or closes a group (a click on it). */
  toggle(g: Group): void {
    for (const c of g.calls) c.open = !g.open;
    for (const c of g.calls) c.invalidate?.();
  }

  private add(c: Call) {
    this.calls.set(c.id, c);
    const owners = INDEX.get(c.id) ?? [];
    if (!owners.includes(this)) INDEX.set(c.id, [...owners, this]);
    const early = this.early.get(c.id);
    if (early) {
      this.early.delete(c.id);
      Object.assign(c, { status: early.outcome, image: early.image });
    }
  }

  private forget(id: string) {
    this.calls.delete(id);
    unindex(id, this);
  }

  private refresh(run: Run) {
    for (const id of run.ids) this.calls.get(id)?.invalidate?.();
  }
}

/** Clicking any row of a group opens or closes that group only. */
const clickable = (g: Group, child: Component): Component =>
  new MouseRegion(child, (e) => {
    if (e.type !== "click" || e.button !== "left") return undefined;
    g.session.toggle(g);
    return { handled: true };
  });

function summaryLine(theme: Theme, g: Group, width: number): string {
  const calls = g.calls.map((c) => ({ summary: c.summary!, status: c.state(), args: c.args }));
  const live = calls.some((c) => c.status === "pending");
  const bad = calls.some((c) => c.status === "error" || c.status === "cancelled");
  const frame = SPINNER[g.session.frame % SPINNER.length];
  const bullet = live ? theme.fg("muted", frame) : theme.fg(bad ? "error" : "success", CALL);
  return truncateToWidth(`${PAD}${bullet} ${summaryText(theme, calls)}`, width);
}

const lineTotals = new WeakMap<object, { added: number; removed: number } | undefined>();

/**
 * A group's summary: "Read 3 files, edited 2 files +442 −12 · 1 failed", counts in the
 * dim colour and "N failed" / "N cancelled" in the error colour. Every call counts
 * under its verb; line totals come from finished calls only. `thought` starts it
 * with "thought ·".
 */
export function summaryText(theme: Theme, calls: { summary: Summary; status: CallState; args?: any }[], thought = false): string {
  const kinds = new Map<string, { s: Summary; n: number; added: number; removed: number }>();
  let failed = 0;
  let cancelled = 0;
  for (const { summary: s, status, args } of calls) {
    if (status === "error") failed++;
    if (status === "cancelled") cancelled++;
    const key = `${s.verb}|${s.one}|${s.many}`;
    const k = kinds.get(key) ?? kinds.set(key, { s, n: 0, added: 0, removed: 0 }).get(key)!;
    k.n++;
    if (status === "done" && s.lines && args && typeof args === "object") {
      if (!lineTotals.has(args)) lineTotals.set(args, s.lines(args));
      k.added += lineTotals.get(args)?.added ?? 0;
      k.removed += lineTotals.get(args)?.removed ?? 0;
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
