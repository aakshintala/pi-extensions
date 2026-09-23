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
  try {
    importPiStamp(section, rig.path, getAgentDir());
  } catch {
    // An unreadable rig.json is already reported as a load warning.
  }
  pi.registerEntryRenderer(STAMP_ENTRY_TYPE, stampRenderer(frozenSettings(section)));

  let tui = false;
  let lastStamp: number | undefined;
  let response: { timestamp: number; firstContentAt?: number; completedAt?: number } | undefined;
  let thinkingLevel: StampThinkingLevel | undefined;
  let cost = noCost();
  const tools = new Map<string, { name: string; startedAt: number; completedAt?: number; outcome?: ToolStampOutcome }>();
  const pendingUsers: number[] = [];

  const append = (stamp: UserStamp | AssistantStamp) => {
    if (!isMessageStamp(stamp)) return;
    pi.appendEntry(STAMP_ENTRY_TYPE, stamp);
    lastStamp = stamp.timestamp;
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
    reset();
    pendingUsers.length = 0;
    tui = ctx.mode === "tui";
    const branch = ctx.sessionManager.getBranch() as unknown[];
    lastStamp = undefined;
    for (let i = branch.length - 1; i >= 0 && lastStamp === undefined; i--) {
      const e = branch[i];
      if (isRecord(e) && e.type === "custom" && e.customType === STAMP_ENTRY_TYPE && isMessageStamp(e.data)) lastStamp = e.data.timestamp;
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
    });
  });

  pi.on("agent_end", () => {
    flushUsers();
    reset();
  });

  pi.on("session_shutdown", () => {
    flushUsers();
    reset();
    tui = false;
    lastStamp = undefined;
    cost = noCost();
  });
}

function isMeaningfulUpdate(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") {
    return typeof value.delta === "string" && value.delta.length > 0;
  }
  if (value.type === "text_end" || value.type === "thinking_end") return typeof value.content === "string" && value.content.length > 0;
  return value.type === "toolcall_end" && isRecord(value.toolCall);
}
