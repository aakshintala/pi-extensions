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
/** A pending grouped call draws nothing until it settles or runs this long, so fast
 * calls (a read) never flash on screen. */
export const SHOW_AFTER_MS = 1000;

const CALL = "⏺";
const RESULT = "⎿";
const PAD = " "; // matches Pi's one-column message padding
const BODY = PAD + "     "; // body text lines up under the summary text

export type CallStatus = "pending" | "done" | "error";

/**
 * A component whose lines are computed for the width it is given, once per width: Pi
 * rebuilds a tool's components on every change, so the lines only change with the width.
 */
export const lines = (render: (width: number) => string[]): Component => {
  let at = -1;
  let out: string[] = [];
  return {
    render: (width) => (width === at ? out : ((out = render(width)), (at = width), out)),
    invalidate: () => void (at = -1),
  };
};

/** `⏺ Title(arg)` on one line, with the bullet coloured by status. */
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

/** Diff lines in the theme's diff colours, hunk breaks as a dim `⋯`. Lines past EXPANDED_LINES are never shown, so stay plain. */
export const diffBody = (theme: Theme, diff: Diff): string[] =>
  diff.lines.map((l, i) =>
    i >= EXPANDED_LINES
      ? l
      : l === "@@"
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
      // No closure here may read `context`: it holds Pi's previous component (lastComponent),
      // whose closures would hold its context, and so on, one link per redraw, never freed.
      const { toolCallId: id, isError, isPartial, cwd, expanded } = context;
      const groups = sessionOf(id, context.args ?? args);
      const c = groups?.describe(id, style.summary, context.invalidate);
      const g = c && groups!.group(id);
      // A running call with a hint (#139) shows the hint under its call line.
      const hint = c?.hint?.();
      const own = (w: number) => {
        const state = c ? c.state() : isError ? "error" : isPartial ? "pending" : "done";
        const status: CallStatus = state === "cancelled" ? "error" : state;
        const line = callLine(theme, status, style.title, style.arg(args ?? ({} as Args), cwd), w);
        return hint ? [line, ...resultLines(theme, theme.fg("dim", hint), [], false, w)] : [line];
      };
      if (!g) return lines(own);
      const open = expanded || g.open;
      const summary = !open && g.calls[0] === c;
      // Collapsed, a group shows one summary line once it is ready: a call settled,
      // a call runs past the grace period, or a call shows its hint. Fresh pending
      // groups (fast calls) draw nothing, so they never flash on screen.
      const now = Date.now();
      const ready = open || g.calls.some((m) => m.state() !== "pending" || m.hint?.() || now - m.startedAt >= g.session.graceMs);
      const shown = open || !!hint;
      return clickable(g, lines((w) => [...(summary && ready ? [summaryLine(theme, g, w)] : []), ...(shown ? own(w) : [])]));
    },
    // Like renderCall, no closure here reads `context`.
    renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext): Component {
      const groups = sessionOf(context.toolCallId, context.args);
      const g = groups?.group(context.toolCallId);
      const collapsed = g && !context.expanded && !g.open;
      if (options.isPartial || collapsed) return lines(() => []);
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

/**
 * A collapsed group is one summary line: failed calls stay folded, image calls stay folded (their text rows draw
 * nothing; Pi still draws the image itself), and Ctrl+O (or a click) shows every call.
 * Pi puts a blank row above every tool that draws a line, so drawing nothing keeps a
 * group free of blank rows (#133).
 */

// ---- Groups (#56, #133) ----
// Consecutive calls to tools with a summary form a group, across assistant messages
// with nothing drawn between them; shell executions fold in too. Only user and
// assistant text, shown thinking, agent completion notices and tools without a summary
// split a group.
// Its first call draws one summary line and the others draw nothing, until Ctrl+O
// (context.expanded) or a click on the group opens it. Groups come from the messages
// alone, so a transcript rebuilt from saved messages groups the same way as the live chat.
//
// Each session owns one ToolGroups (its extension creates it and drives it from Pi's
// events). Renderers find a call's session through a
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

/** Last lines Pi's tools and agent loop give a call stopped by an abort (bash appends its own). */
const ABORT_TEXTS = ["Operation aborted", "Command aborted"];

/**
 * How a finished call ended, from data Pi saves with it: an error ending in Pi's own
 * abort text is a cancel, any other error a failure.
 */
export const outcomeOf = (isError: boolean, result: unknown): Outcome =>
  !isError ? "done" : ABORT_TEXTS.includes(resultText(result).trim().split("\n").at(-1)!.trim()) ? "cancelled" : "error";

/** Consecutive calls across assistant messages with no text or message between them. */
interface Run {
  ids: string[];
  /** Set when a message or its turn ended: what a call with no result counts as. */
  ended?: "cancelled" | "error";
}

/** One assistant message with calls. */
interface Msg {
  ids: string[];
  /** The run open before it, which it continues when it has no text. */
  before?: Run;
  /**
   * It has thinking. As the message's renderer last reported: `shown`, whether Pi
   * draws that thinking, and `hides`, whether Pi hides thinking in this message.
   */
  thought: boolean;
  shown?: boolean;
  hides?: boolean;
  /** A message with only thinking came just before it, or just after it. */
  gap: boolean;
  after: boolean;
}

class Call {
  status: CallState = "pending";
  /** When the call was registered: pending calls older than the grace period show. */
  startedAt = Date.now();
  open = false;
  summary?: Summary;
  invalidate?: () => void;
  /** While running: the hint it shows (see `showHint`). */
  hint?: () => string | undefined;
  id: string;
  run: Run;
  msg: Msg;
  args: unknown;
  constructor(id: string, run: Run, msg: Msg, args: unknown) {
    this.id = id;
    this.run = run;
    this.msg = msg;
    this.args = args;
  }
  state(): CallState {
    return this.status === "pending" && this.run.ended ? this.run.ended : this.status;
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

/**
 * Shows running call `id` of session `owner` outside its group, with a dim
 * line of `hint()` under its call line, until the returned function is called; it then
 * folds back in. `hint` is read on every draw; while it returns nothing the call stays
 * folded. Needs the session's groups (extensions/tool-display).
 */
export function showHint(owner: string, id: string, hint: () => string | undefined): () => void {
  const groups = INDEX.get(id)?.find((g) => g.owner === owner);
  const c = groups?.hinted(id, hint);
  return () => void (c && groups!.hinted(id, undefined, c));
}

/** Messages Pi draws in the chat, besides assistant messages (a custom one when `display` is set).
 * Shell executions fold into the groups around them; user prompts, compaction and
 * branch summaries, and drawn custom messages (agent completion notices) split them. */
const SPLITS = new Set(["user", "compactionSummary", "branchSummary"]);

/** One session's tool groups. */
export class ToolGroups {
  private calls = new Map<string, Call>();
  /** Results that arrived before their call was registered. */
  private early = new Map<string, Outcome>();
  /** The run a next message of calls only continues. */
  private tail?: Run;
  /** The message still streaming: later updates of it are the same message. */
  private current?: Msg;
  /** A message with only thinking came after the tail. */
  private gap = false;
  /** Whether Pi draws thinking, for messages whose renderer has not reported (Pi's default: yes). */
  showThinking = true;
  /** Pending grouped calls show once settled or older than this. Tests set it to 0. */
  graceMs = ToolGroups.defaultGraceMs;
  /** Process-wide default grace period (see SHOW_AFTER_MS): tests set it to 0 and restore it after. */
  static defaultGraceMs = SHOW_AFTER_MS;
  /** The session's id, which `showHint` names it by. Its extension sets it. */
  owner?: string;

  /**
   * Feeds one message, in order. An assistant message registers its calls: pass
   * `streaming` for each update while it streams, and track it once more without it
   * when it ends. A message drawn in the chat closes the open run.
   */
  track(message: any, streaming = false): void {
    if (SPLITS.has(message?.role) || (message?.role === "custom" && message.display)) return this.close();
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const runs: any[][] = [[]];
    let text = false;
    for (const b of message.content) {
      if (b?.type === "toolCall" && typeof b.id === "string") runs.at(-1)!.push(b);
      else if (b?.type === "text" && b.text?.trim()) (text = true), runs.push([]);
    }
    const thought = message.content.some((b: any) => b?.type === "thinking" && b.thinking?.trim());
    const segments = runs.filter((r) => r.length);
    if (!segments.length) {
      if (text) return this.close();
      // A finished message with only thinking: it belongs to the run around it.
      if (thought && !streaming && this.tail) {
        const last = this.calls.get(this.tail.ids.at(-1)!);
        if (last) last.msg.after = true;
        this.gap = true;
        this.refresh(this.tail);
      }
      return;
    }
    // Each streaming update is a new object, and its first call can be revised out,
    // so a message is the one still streaming, or a new one.
    const msg: Msg = this.current ?? { ids: [], before: this.tail, thought, gap: this.gap, after: false };
    this.current = streaming ? msg : undefined;
    this.gap = false;
    const all = segments.flat().map((b) => b.id as string);
    // A call revised out of the message leaves its group, and an id that an earlier
    // message used belongs to this one now.
    const keep = new Set(all);
    for (const id of msg.ids) if (!keep.has(id)) this.forget(id);
    for (const id of all) if (this.calls.get(id) && this.calls.get(id)!.msg !== msg) this.forget(id);
    msg.ids = all;
    let changed = msg.thought !== thought;
    msg.thought = thought;
    // Pi draws all of a message's text above its calls, so only a message without
    // text continues the run before it.
    const join = text ? undefined : msg.before;
    const ended = message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : undefined;
    const mine = (id: string) => this.calls.get(id)?.msg === msg;
    const used = new Set<Run>();
    for (const [i, blocks] of segments.entries()) {
      const ids = blocks.map((b) => b.id as string);
      const old = this.calls.get(ids[0])?.run;
      const run: Run = i === 0 && join ? join : old && !used.has(old) && old.ids.every(mine) ? old : { ids: [] };
      used.add(run);
      const next = [...run.ids.filter((id) => !mine(id)), ...ids];
      changed ||= next.length !== run.ids.length || next.some((id, j) => id !== run.ids[j]) || (!!ended && !run.ended);
      run.ids = next;
      run.ended ??= ended;
      for (const b of blocks) {
        const c = this.calls.get(b.id);
        if (!c) this.add(new Call(b.id, run, msg, b.arguments));
        else {
          if (c.run !== run) this.leave(c);
          Object.assign(c, { run, args: b.arguments });
        }
      }
      if (changed) this.refresh(run);
      this.tail = run;
    }
    // An aborted or failed message is the last of its agent run.
    if (ended && !streaming) this.close();
  }

  /** Records whether Pi draws a message's thinking (its renderer calls this; see `thinkingShown`). */
  thinkingShown(id: string, shown: boolean, hides: boolean): void {
    const msg = this.calls.get(id)?.msg;
    if (!msg || (msg.shown === shown && msg.hides === hides)) return;
    Object.assign(msg, { shown, hides });
    // Drawn thinking splits a group, so the groups around it change.
    for (const c of this.calls.values()) if (c.msg === msg) this.refresh(c.run);
  }

  /** Records a call's result (Pi's tool_execution_end, or a saved toolResult message). */
  settle(id: string, isError: boolean, result: unknown): void {
    const outcome = outcomeOf(isError, result);
    const c = this.calls.get(id);
    if (!c) return void this.early.set(id, outcome);
    c.status = outcome;
    this.refresh(c.run);
  }

  /** The agent run is over: the open run closes, and calls still without a result are cancelled. */
  endRun(): void {
    this.close();
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
    this.close();
  }

  /** Recheck pending groups after their grace period and hints whose text may change. */
  refreshPending(): void {
    // Only a pending call's group leader draws the grace-period reveal.
    const redraw = new Set<Call>();
    for (const c of this.calls.values()) {
      if (c.hint) redraw.add(c);
      else if (c.state() === "pending") {
        const leader = this.group(c.id)?.calls[0];
        if (leader) redraw.add(leader);
      }
    }
    for (const c of redraw) {
      try {
        c.invalidate?.();
      } catch {}
    }
  }

  /**
   * Sets or clears a call's hint (see `showHint`) and redraws the call. Clearing with
   * `only` leaves a call that has been replaced since.
   */
  hinted(id: string, hint: (() => string | undefined) | undefined, only?: Call): Call | undefined {
    const c = this.calls.get(id);
    if (!c || (only && c !== only)) return undefined;
    c.hint = hint;
    c.invalidate?.();
    return c;
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
   * The call's group: the calls around it in its run that have a summary, up to thinking
   * Pi draws between two messages. Pi renders calls in message order, so every call
   * before this one has already described itself.
   */
  group(id: string): Group | undefined {
    const c = this.calls.get(id);
    if (!c?.summary) return undefined;
    const ids = c.run.ids;
    const at = (i: number) => this.calls.get(ids[i]);
    // Calls i-1 and i are in one group.
    const joined = (i: number) => {
      const a = at(i - 1);
      const b = at(i);
      return !!a?.summary && !!b?.summary && (a.msg === b.msg || !this.drawsThinking(b.msg));
    };
    let start = ids.indexOf(id);
    let end = start;
    while (start > 0 && joined(start)) start--;
    while (end < ids.length - 1 && joined(end + 1)) end++;
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

  /** Pi draws thinking just above the message's calls. */
  private drawsThinking(m: Msg) {
    // A message with only thinking before it is drawn as this message's thinking would be.
    return (m.thought && (m.shown ?? this.showThinking)) || (m.gap && !(m.hides ?? !this.showThinking));
  }

  /** Seals the open run. Called for every streamed text token, so a no-op once sealed. */
  private close() {
    if (!this.tail && !this.current && !this.gap) return;
    const runs = new Set([this.tail, ...(this.current?.ids ?? []).map((id) => this.calls.get(id)?.run)]);
    // Clear first: each invalidate re-renders synchronously and must see the sealed runs.
    this.tail = undefined;
    this.current = undefined;
    this.gap = false;
    // group() never reads the tail, so only the sealed runs' calls redraw.
    for (const run of runs) if (run) this.refresh(run);
  }

  private add(c: Call) {
    this.calls.set(c.id, c);
    const owners = INDEX.get(c.id) ?? [];
    if (!owners.includes(this)) INDEX.set(c.id, [...owners, this]);
    const early = this.early.get(c.id);
    if (early) {
      this.early.delete(c.id);
      c.status = early;
    }
  }

  private forget(id: string) {
    const c = this.calls.get(id);
    if (c) this.leave(c);
    this.calls.delete(id);
    unindex(id, this);
  }

  /** Takes a call out of its run (it moved to another, or left the message). */
  private leave(c: Call) {
    c.run.ids = c.run.ids.filter((id) => id !== c.id);
    this.refresh(c.run);
  }

  private refresh(run: Run) {
    for (const id of run.ids) {
      try {
        this.calls.get(id)?.invalidate?.();
      } catch {}
    }
  }
}

/**
 * Pi's assistant message renderer reports whether it draws the message's thinking
 * (Ctrl+T, or a click on one block), and whether it hides thinking as a rule;
 * drawn thinking splits a group.
 */
export function thinkingShown(message: any, shown: boolean, hides = !shown): void {
  const call = Array.isArray(message?.content) && message.content.find((b: any) => b?.type === "toolCall" && typeof b.id === "string");
  if (call) sessionOf(call.id, call.arguments)?.thinkingShown(call.id, shown, hides);
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
  return truncateToWidth(`${PAD}${theme.fg("muted", CALL)} ${summaryText(theme, calls, g.calls.some((c) => c.msg.thought || c.msg.gap || c.msg.after))}`, width);
}

const lineTotals = new WeakMap<object, { added: number; removed: number } | undefined>();

/**
 * A group's summary: "Read 3 files, edited 2 files +442 −12". Every call counts
 * under its verb; line totals come from finished calls only. `thought` starts it
 * with "thought ·". Failures and cancellations remain in expanded call results.
 */
export function summaryText(theme: Theme, calls: { summary: Summary; status: CallState; args?: any }[], thought = false): string {
  const kinds = new Map<string, { s: Summary; n: number; added: number; removed: number }>();
  for (const { summary: s, status, args } of calls) {
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
  return parts.filter(Boolean).join(sep);
}

/** A path shown relative to the working directory when it is inside it. */
export function shortPath(path: unknown, cwd: string): string {
  if (typeof path !== "string") return "";
  return cwd && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

const withEol = (s: string) => (s === "" || s.endsWith("\n") ? s : s + "\n");
