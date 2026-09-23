// Stamp entries: their persisted shapes (every version ever written, so old sessions
// still render) and the renderer that draws them right-aligned.
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  formatExactTimelineLine,
  formatMessageStampLabel,
  isValidTimestamp,
  type StampSettings,
  type TimelineBoundary,
} from "./format.ts";
import {
  type AssistantMetadataData,
  formatAssistantMetadataLines,
  formatToolStampLabel,
  isAssistantEstimatedCost,
  isAssistantMetadataData,
  isStampThinkingLevel,
  sanitizeMetadataText,
  type StampThinkingLevel,
  type ToolStampOutcome,
} from "./metadata.ts";

export const STAMP_ENTRY_TYPE = "pi-stamp";

export interface ToolTiming {
  name: string;
  startedAt: number;
  completedAt: number;
  outcome: ToolStampOutcome;
}

/** User stamps are still written as version 2. */
export interface UserStamp {
  version: 2;
  role: "user";
  timestamp: number;
  previousTimestamp?: number;
}

/** The one assistant shape written now. Everything is recorded; settings decide what shows. */
export interface AssistantStamp {
  version: 7;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata?: AssistantMetadataData;
  thinkingLevel?: StampThinkingLevel;
  estimatedCost?: number;
  costSinceUser?: number;
  tools?: ToolTiming[];
  /** No text: the response only called tools. Absent in entries written before #142. */
  toolOnly?: true;
  /** When this reply ends a run of tool-only responses: the first one's timestamp. */
  runStartedAt?: number;
}

// Read-only shapes written by earlier versions of the fork.
type LegacyMessageStamp = {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  role: "user" | "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata?: AssistantMetadataData;
  thinkingLevel?: StampThinkingLevel;
  estimatedCost?: number;
  costSinceUser?: number;
};
type LegacyToolStamp = {
  version: 1;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  startedAt: number;
  completedAt: number;
  outcome: ToolStampOutcome;
};

type MessageStamp = UserStamp | AssistantStamp | LegacyMessageStamp;

const TIMING_KEYS = ["version", "role", "timestamp", "previousTimestamp", "completedAt", "firstContentAt"];
const KEYS: Record<number, string[]> = {
  1: ["version", "role", "timestamp"],
  2: TIMING_KEYS.slice(0, 4),
  3: TIMING_KEYS,
  4: [...TIMING_KEYS, "metadata"],
  5: [...TIMING_KEYS, "metadata", "thinkingLevel"],
  6: [...TIMING_KEYS, "metadata", "thinkingLevel", "estimatedCost", "costSinceUser"],
  7: [...TIMING_KEYS, "metadata", "thinkingLevel", "estimatedCost", "costSinceUser", "tools", "toolOnly", "runStartedAt"],
};

export function isMessageStamp(value: unknown): value is MessageStamp {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant") || !isValidTimestamp(value.timestamp)) return false;
  const v = value.version as number;
  if (!Number.isInteger(v) || !KEYS[v] || !hasOnlyKeys(value, KEYS[v])) return false;
  const has = (k: string) => Object.hasOwn(value, k);
  if (has("previousTimestamp") && !isValidTimestamp(value.previousTimestamp)) return false;
  if (v <= 2) return true;
  if (value.role !== "assistant") return false;
  if (v === 3 && !has("completedAt")) return false;
  if (!hasValidTiming(value, value.timestamp)) return false;
  if ((v === 4 || v === 5 || has("metadata")) && !isAssistantMetadataData(value.metadata)) return false;
  if ((v === 5 || has("thinkingLevel")) && !isStampThinkingLevel(value.thinkingLevel)) return false;
  if ((v === 6 || has("costSinceUser")) && !isAssistantEstimatedCost(value.costSinceUser)) return false;
  if (has("estimatedCost")) {
    if (!isAssistantEstimatedCost(value.estimatedCost)) return false;
    if (has("costSinceUser") && value.estimatedCost > (value.costSinceUser as number)) return false;
  }
  if (has("toolOnly") && value.toolOnly !== true) return false;
  if (has("runStartedAt") && !(isValidTimestamp(value.runStartedAt) && value.runStartedAt <= value.timestamp)) return false;
  return !has("tools") || (Array.isArray(value.tools) && value.tools.every(isToolTiming));
}

export function isToolTiming(value: unknown): value is ToolTiming {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "startedAt", "completedAt", "outcome"]) &&
    isSafeText(value.name) &&
    isValidTimestamp(value.startedAt) &&
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= value.startedAt &&
    (value.outcome === "success" || value.outcome === "error")
  );
}

function isLegacyToolStamp(value: unknown): value is LegacyToolStamp {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === "tool" &&
    hasOnlyKeys(value, ["version", "kind", "toolCallId", "toolName", "startedAt", "completedAt", "outcome"]) &&
    isSafeText(value.toolCallId) &&
    isToolTiming({ name: value.toolName, startedAt: value.startedAt, completedAt: value.completedAt, outcome: value.outcome })
  );
}

interface Line {
  text: string;
  /** Exact lines hard-wrap by character so timestamps are never split at spaces. */
  exact: boolean;
}

/**
 * Renders every valid stamp entry as a component, including tool stamps while
 * `toolStamps` is off (they render no lines), so changing a setting reaches every
 * stamp already on screen. The exception is a tool-only response while `toolStamps`
 * is off: Pi puts a spacer row above every component, so it gets none, and a later
 * change reaches it when Pi rebuilds the chat. Lines are rebuilt only when the frozen
 * settings object changes, and wrapped output only when the width changes too.
 */
export function stampRenderer(settings: () => Readonly<StampSettings>): EntryRenderer {
  return (entry, options, theme) => {
    const data = entry.data;
    let lines: (s: Readonly<StampSettings>) => Line[];
    if (isLegacyToolStamp(data)) {
      const tool = { name: data.toolName, startedAt: data.startedAt, completedAt: data.completedAt, outcome: data.outcome };
      lines = (s) => toolLines([tool], s, options.expanded);
    } else if (isMessageStamp(data)) {
      // Zero lines would still leave Pi's spacer row, so a hidden stamp is no component.
      if (isHidden(data, settings())) return undefined;
      lines = (s) => messageLines(data, s, options.expanded);
    } else return undefined;
    return rightAligned(lines, settings, theme);
  };
}

function messageLines(data: MessageStamp, s: Readonly<StampSettings>, expanded: boolean): Line[] {
  if (isHidden(data, s)) return [];
  const label = formatMessageStampLabel(data, s);
  if (!label) return [];
  const timeline: Array<[TimelineBoundary, number | undefined]> = [
    ["created", data.timestamp],
    ["first content", data.firstContentAt],
    ["completed", data.completedAt],
  ];
  const cost = s.showCostSinceUser && data.costSinceUser !== undefined
    ? { ...(data.estimatedCost === undefined ? {} : { estimatedCost: data.estimatedCost }), costSinceUser: data.costSinceUser }
    : undefined;
  const metadata = formatAssistantMetadataLines(
    data.metadata,
    s.assistantMetadata,
    expanded,
    s.showThinkingLevel ? data.thinkingLevel : undefined,
    s.showCompactAbnormalOutcome,
    cost,
  );
  return [
    line(label),
    ...(expanded && s.showExactTimeline ? exactLines(timeline) : []),
    ...metadata.map(line),
    ...("tools" in data && data.tools ? toolLines(data.tools, s, expanded) : []),
  ];
}

/** A tool-only response draws nothing in the chat (#142), so neither does its stamp, unless tool stamps are on. */
const isHidden = (data: MessageStamp, s: Readonly<StampSettings>) => "toolOnly" in data && data.toolOnly === true && !s.toolStamps;

function toolLines(tools: readonly ToolTiming[], s: Readonly<StampSettings>, expanded: boolean): Line[] {
  if (!s.toolStamps) return [];
  return tools.flatMap((t) => {
    const label = formatToolStampLabel(t.name, t.completedAt - t.startedAt, t.outcome);
    if (!label) return [];
    const timeline: Array<[TimelineBoundary, number]> = [["started", t.startedAt], ["completed", t.completedAt]];
    return [line(label), ...(expanded && s.showExactTimeline ? exactLines(timeline) : [])];
  });
}

const line = (text: string): Line => ({ text, exact: false });

function exactLines(observations: ReadonlyArray<readonly [TimelineBoundary, number | undefined]>): Line[] {
  return observations.flatMap(([boundary, timestamp]) => {
    const text = timestamp === undefined ? undefined : formatExactTimelineLine(boundary, timestamp);
    return text ? [{ text, exact: true }] : [];
  });
}

function rightAligned(
  build: (s: Readonly<StampSettings>) => Line[],
  settings: () => Readonly<StampSettings>,
  // Pi's theme is live (a proxy over the current theme), so colours are read when output is rebuilt.
  theme: Pick<Theme, "fg">,
): Component {
  let seen: Readonly<StampSettings> | undefined;
  let lines: Line[] = [];
  let width = -1;
  let output: string[] = [];
  return {
    render(w) {
      if (w < 1) return [];
      const s = settings();
      if (s !== seen) {
        seen = s;
        lines = build(s);
        width = -1;
      }
      if (w !== width) {
        width = w;
        const style = (text: string) => theme.fg("dim", text);
        output = lines.flatMap((source) => {
          const wrapped = source.exact ? hardWrap(source.text, w).map(style) : wrapTextWithAnsi(style(source.text), w);
          return wrapped.map((l) => " ".repeat(Math.max(0, w - visibleWidth(l))) + l);
        });
      }
      return output;
    },
    invalidate() {
      width = -1;
      output = [];
    },
  };
}

function hardWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const character of text) {
    const w = visibleWidth(character);
    if (current && currentWidth + w > width) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    if (w > width) continue;
    current += character;
    currentWidth += w;
  }
  if (current) lines.push(current);
  return lines;
}

function hasValidTiming(value: Record<string, unknown>, timestamp: number): boolean {
  if (!Object.hasOwn(value, "completedAt")) return !Object.hasOwn(value, "firstContentAt");
  return (
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= timestamp &&
    (!Object.hasOwn(value, "firstContentAt") ||
      (isValidTimestamp(value.firstContentAt) && value.firstContentAt >= timestamp && value.firstContentAt <= value.completedAt))
  );
}

export const isSafeText = (value: unknown): value is string => typeof value === "string" && sanitizeMetadataText(value) === value;
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((k) => allowed.includes(k));
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
