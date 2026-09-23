// Stamp: timestamps, response timing, metadata and tool durations in the transcript
// (spec #36). Ported from the local pi-stamp fork of @narumitw/pi-stamp 0.51.0 (MIT).
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { isValidTimestamp } from "./format.ts";
import {
  captureAssistantMetadata,
  captureReportedCost,
  isAssistantEstimatedCost,
  isStampThinkingLevel,
  sanitizeMetadataText,
  type StampThinkingLevel,
  type ToolStampOutcome,
} from "./metadata.ts";
import {
  type AssistantStamp,
  isMessageStamp,
  isRecord,
  isSafeText,
  STAMP_ENTRY_TYPE,
  stampRenderer,
  type ToolTiming,
  type UserStamp,
} from "./render.ts";
import { frozenSettings, importPiStamp, SETTINGS } from "./settings.ts";

const MAX_TOOL_TIMINGS = 256;

type Cost = { total: number; reported: boolean; valid: boolean };
const noCost = (): Cost => ({ total: 0, reported: false, valid: true });

export default function stamp(pi: ExtensionAPI, { now = Date.now }: { now?: () => number } = {}) {
  const rig = rigSettings(getAgentDir());
  const section = rig.declare("stamp", SETTINGS);
  // Subscribed on first use, released on shutdown.
  let live: ReturnType<typeof frozenSettings> | undefined;
  pi.registerEntryRenderer(STAMP_ENTRY_TYPE, stampRenderer(() => (live ??= frozenSettings(section)).get()));

  let tui = false;
  let lastStamp: number | undefined;
  let response: { timestamp: number; firstContentAt?: number; completedAt?: number } | undefined;
  let thinkingLevel: StampThinkingLevel | undefined;
  let cost = noCost();
  // The first tool-only response of the current run; the reply that ends the run is timed from it.
  let runStart: number | undefined;
  const tools = new Map<string, { name: string; startedAt: number; completedAt?: number; outcome?: ToolStampOutcome }>();
  const pendingUsers: number[] = [];

  const append = (stamp: UserStamp | AssistantStamp) => {
    if (!isMessageStamp(stamp)) return;
    pi.appendEntry(STAMP_ENTRY_TYPE, stamp);
    // A tool-only stamp draws no row, so the next one's date context skips it.
    if (!("toolOnly" in stamp)) lastStamp = stamp.timestamp;
  };
  const previous = () => (lastStamp === undefined ? {} : { previousTimestamp: lastStamp });
  const flushUsers = () => {
    if (tui) for (const timestamp of pendingUsers) append({ version: 2, role: "user", timestamp, ...previous() });
    pendingUsers.length = 0;
  };
  const addCost = (c: Cost, amount: number | undefined) => {
    if (amount === undefined || !c.valid) return;
    if (!isAssistantEstimatedCost(c.total + amount)) c.valid = false;
    else Object.assign(c, { total: c.total + amount, reported: true });
  };
  const reset = () => {
    response = undefined;
    thinkingLevel = undefined;
    tools.clear();
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      importPiStamp(section, rig.path, getAgentDir());
    } catch (e) {
      if (ctx.hasUI) ctx.ui.notify(`stamp: could not import pi-stamp.json: ${(e as Error).message}`, "warning");
    }
    reset();
    pendingUsers.length = 0;
    runStart = undefined;
    tui = ctx.mode === "tui";
    const branch = ctx.sessionManager.getBranch() as unknown[];
    lastStamp = undefined;
    for (let i = branch.length - 1; i >= 0 && lastStamp === undefined; i--) {
      const e = branch[i];
      if (isRecord(e) && e.type === "custom" && e.customType === STAMP_ENTRY_TYPE && isMessageStamp(e.data) && !("toolOnly" in e.data)) {
        lastStamp = e.data.timestamp;
      }
    }
    // Cost since the last user message, for a resumed session.
    cost = noCost();
    let start = 0;
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (isRecord(e) && e.type === "message" && isRecord(e.message) && e.message.role === "user") {
        start = i + 1;
        break;
      }
    }
    for (const e of branch.slice(start)) {
      if (isRecord(e) && e.type === "message" && isRecord(e.message) && (e.message.role === "assistant" || e.message.role === "toolResult")) {
        addCost(cost, captureReportedCost(e.message));
      }
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    reset();
    thinkingLevel = tui && isStampThinkingLevel(ctx.thinkingLevel) ? ctx.thinkingLevel : undefined;
  });

  pi.on("tool_execution_start", (event) => {
    if (!tui || tools.size >= MAX_TOOL_TIMINGS || tools.has(event.toolCallId) || !isSafeText(event.toolCallId)) return;
    const name = sanitizeMetadataText(event.toolName);
    const startedAt = now();
    if (name && isValidTimestamp(startedAt)) tools.set(event.toolCallId, { name, startedAt });
  });

  pi.on("tool_execution_end", (event) => {
    const timing = tools.get(event.toolCallId);
    if (!timing || timing.completedAt !== undefined) return;
    const completedAt = now();
    if (!isValidTimestamp(completedAt) || completedAt < timing.startedAt) tools.delete(event.toolCallId);
    else Object.assign(timing, { completedAt, outcome: event.isError ? "error" : "success" });
  });

  pi.on("message_start", (event) => {
    flushUsers();
    if (tui && event.message.role === "assistant" && isValidTimestamp(event.message.timestamp)) {
      response = { timestamp: event.message.timestamp };
    }
  });

  pi.on("message_update", (event) => {
    if (
      response &&
      response.firstContentAt === undefined &&
      event.message.role === "assistant" &&
      response.timestamp === event.message.timestamp &&
      isMeaningfulUpdate(event.assistantMessageEvent)
    ) {
      const t = now();
      if (isValidTimestamp(t)) response.firstContentAt = t;
    }
  });

  pi.on("message_end", (event) => {
    if (!tui) return;
    const { message } = event;
    if (message.role === "user") {
      cost = noCost();
      runStart = undefined;
      if (isValidTimestamp(message.timestamp)) pendingUsers.push(message.timestamp);
      return;
    }
    if (message.role !== "assistant" || !isValidTimestamp(message.timestamp)) return;
    const first = response?.timestamp === message.timestamp ? response.firstContentAt : undefined;
    const completedAt = now();
    response =
      isValidTimestamp(completedAt) && completedAt >= message.timestamp
        ? { timestamp: message.timestamp, completedAt, ...(first !== undefined && first <= completedAt ? { firstContentAt: first } : {}) }
        : undefined;
  });

  pi.on("turn_end", (event) => {
    const timing = response;
    const level = thinkingLevel;
    const message = event.message;
    const done: ToolTiming[] = [];
    for (const result of event.toolResults as unknown[]) {
      const t = isRecord(result) && typeof result.toolCallId === "string" ? tools.get(result.toolCallId) : undefined;
      if (t?.completedAt !== undefined && t.outcome) done.push({ name: t.name, startedAt: t.startedAt, completedAt: t.completedAt, outcome: t.outcome });
    }
    reset();
    if (!tui || message.role !== "assistant") return;
    const estimatedCost = captureReportedCost(message);
    addCost(cost, estimatedCost);
    for (const r of event.toolResults) addCost(cost, captureReportedCost(r));
    const metadata = captureAssistantMetadata(message);
    const withCost = message.stopReason !== "toolUse" && cost.valid && cost.reported;
    const toolOnly = isToolOnly(message);
    const run = toolOnly ? undefined : runStart;
    runStart = toolOnly ? (runStart ?? message.timestamp) : undefined;
    append({
      version: 7,
      role: "assistant",
      timestamp: message.timestamp,
      ...previous(),
      ...(timing?.timestamp === message.timestamp && timing.completedAt !== undefined
        ? { completedAt: timing.completedAt, ...(timing.firstContentAt === undefined ? {} : { firstContentAt: timing.firstContentAt }) }
        : {}),
      ...(metadata ? { metadata } : {}),
      ...(level === undefined ? {} : { thinkingLevel: level }),
      ...(withCost ? { ...(estimatedCost === undefined ? {} : { estimatedCost }), costSinceUser: cost.total } : {}),
      ...(done.length ? { tools: done } : {}),
      ...(toolOnly ? { toolOnly: true } : {}),
      ...(run === undefined ? {} : { runStartedAt: run }),
    });
  });

  pi.on("agent_end", () => {
    flushUsers();
    reset();
  });

  pi.on("session_shutdown", () => {
    live?.stop();
    live = undefined;
    flushUsers();
    reset();
    tui = false;
    lastStamp = undefined;
    runStart = undefined;
    cost = noCost();
  });
}

/**
 * A response that only calls tools, which Pi draws nothing for: no text, only thinking
 * (if any) and the calls. Pi still draws its error line for an aborted or failed one
 * with no calls, and its truncation line for a `length` stop.
 */
function isToolOnly(message: { stopReason?: string; content?: unknown }): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  return (
    message.stopReason !== "length" &&
    content.some((b) => isRecord(b) && b.type === "toolCall") &&
    !content.some((b) => isRecord(b) && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
  );
}

function isMeaningfulUpdate(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") {
    return typeof value.delta === "string" && value.delta.length > 0;
  }
  if (value.type === "text_end" || value.type === "thinking_end") return typeof value.content === "string" && value.content.length > 0;
  return value.type === "toolcall_end" && isRecord(value.toolCall);
}
