// Shared tool-display style (spec #40): Claude Code-style call lines, collapsed
// results, error lines and capped unified diffs. Every rig tool and the built-in
// decorator render through here; grouping (#56) builds on the same pieces.
import { generateUnifiedPatch, keyText, type Theme, type ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

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
export const resultText = (result: { content: { type: string; text?: string }[] }) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

/** What one tool contributes: a title, the call's argument, and its result summary and body. */
export interface ToolStyle<Args = any, Result = any> {
  title: string;
  arg(args: Args, cwd: string): string;
  result(result: Result, args: Args, expanded: boolean, theme: Theme): { summary: string; body: string[] };
}

/**
 * renderShell/renderCall/renderResult for a tool, drawn in the shared style. With
 * `renderShell: "self"` the call and result own every row, so a group (#56) can
 * make a member render zero lines.
 */
export function toolRenderers<Args, Result>(style: ToolStyle<Args, Result>) {
  return {
    renderShell: "self" as const,
    renderCall(args: Args, theme: Theme, context: ToolRenderContext): Component {
      const status: CallStatus = context.isError ? "error" : context.isPartial ? "pending" : "done";
      return lines((w) => [callLine(theme, status, style.title, style.arg(args ?? ({} as Args), context.cwd), w)]);
    },
    renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext): Component {
      if (options.isPartial) return lines(() => []);
      if (context.isError) {
        const message = resultText(result as any).replaceAll(`${context.cwd}/`, "");
        return lines((w) => errorLines(theme, message, options.expanded, w));
      }
      const { summary, body } = style.result(result, context.args ?? {}, options.expanded, theme);
      return lines((w) => resultLines(theme, summary, body, options.expanded, w));
    },
  };
}

/** A path shown relative to the working directory when it is inside it. */
export function shortPath(path: unknown, cwd: string): string {
  if (typeof path !== "string") return "";
  return cwd && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

const withEol = (s: string) => (s === "" || s.endsWith("\n") ? s : s + "\n");
