/**
 * Data collection and caching for the /usage dashboard.
 *
 * Performance model (upstream CHANGELOG 0.4.0):
 * - Session JSONL files are scanned at the buffer level. Only lines relevant
 *   to assistant or auxiliary accounting are decoded and JSON.parsed. Ordinary
 *   multi-megabyte tool results are skipped; accounting-bearing large results
 *   use an allocation-safe byte parser for their small metadata fields.
 * - Per-file extraction results are persisted to an on-disk cache keyed by
 *   (size, mtimeMs). Session files are append-only, so a warm load only
 *   re-parses files that changed since the last run.
 */

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface TokenStats {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface BaseStats {
	messages: number;
	cost: number;
	tokens: TokenStats;
}

export interface ModelStats extends BaseStats {
	sessions: Set<string>;
}

export interface ProviderStats extends BaseStats {
	sessions: Set<string>;
	models: Map<string, ModelStats>;
}

export interface TotalStats extends BaseStats {
	sessions: number;
}

export interface TimeFilteredStats {
	providers: Map<string, ProviderStats>;
	totals: TotalStats;
}

/**
 * One (provider, model, thinkingLevel) cell inside an hourly bucket.
 * Powers the graph explorer; built post-dedupe so it matches table totals.
 */
export interface HourlyCell {
	messages: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

/** Composite key: `${provider}\u0000${model}\u0000${thinkingLevel}` */
export type HourlyKey = string;

export const HOURLY_KEY_SEP = "\u0000";

export function makeHourlyKey(provider: string, model: string, thinkingLevel: string): HourlyKey {
	return provider + HOURLY_KEY_SEP + model + HOURLY_KEY_SEP + thinkingLevel;
}

export function splitHourlyKey(key: HourlyKey): { provider: string; model: string; thinkingLevel: string } {
	const [provider = "", model = "", thinkingLevel = ""] = key.split(HOURLY_KEY_SEP);
	return { provider, model, thinkingLevel };
}

export interface PeriodBounds {
	todayMs: number;
	weekStartMs: number;
	lastWeekStartMs: number;
	last30DaysStartMs: number;
	nowMs: number;
}

export interface UsageData {
	today: TimeFilteredStats;
	thisWeek: TimeFilteredStats;
	lastWeek: TimeFilteredStats;
	last30Days: TimeFilteredStats;
	allTime: TimeFilteredStats;
	/** Deduped usage bucketed by hour start (ms) → series key → metrics. */
	hourly: Map<number, Map<HourlyKey, HourlyCell>>;
	bounds: PeriodBounds;
}

export type TabName = "today" | "thisWeek" | "lastWeek" | "last30Days" | "allTime";

export const TAB_ORDER: TabName[] = ["today", "thisWeek", "lastWeek", "last30Days", "allTime"];

export type UsageSource = "assistant" | "auxiliary";

/** Pi's own label for usage that cannot be attributed to a provider/model. */
export const AUXILIARY_PROVIDER = "Tools";
export const AUXILIARY_MODEL = "summaries";
export const AUXILIARY_THINKING_LEVEL = "Tools/summaries";

export interface UsageAmount {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface SessionMessage extends UsageAmount {
	provider: string;
	model: string;
	/** Thinking level active when the message was produced; "" when unknown. */
	thinkingLevel: string;
	/** Assistant response, or usage reported by a tool/summary entry. */
	source: UsageSource;
	/** Session entry id used to dedupe copied auxiliary entries; empty for assistant messages. */
	sourceId: string;
	timestamp: number;
}

export interface ChildToolUsage {
	resultIndex: number;
	/** Persisted child session path when the tool supplied one; empty otherwise. */
	sessionFile: string;
	usage: UsageAmount;
}

export interface ToolUsageRecord {
	/** Parent tool-result entry id, stable across copied branch history. */
	sourceId: string;
	timestamp: number;
	/** Canonical Pi 0.81+ tool usage; null for legacy nested-agent results. */
	reportedUsage: UsageAmount | null;
	/** Run id used to derive the standard nested-session path when needed. */
	runId: string;
	/** Recognised per-child usage from nested-agent tool details. */
	children: ChildToolUsage[];
}

export interface ParsedSessionFile {
	/** Empty string when the file has no session header — such files are ignored. */
	sessionId: string;
	/** Working directory from the session header; "" when absent. */
	cwd: string;
	/** Extracted assistant and summary usage records, pre-dedupe. */
	messages: SessionMessage[];
	/** Tool usage is reconciled against recursively scanned child sessions later. */
	toolUsages: ToolUsageRecord[];
}

// =============================================================================
// Paths
// =============================================================================

/**
 * The folder whose session files /usage reads. `effectiveDir` is the running
 * session's folder from Pi (`ctx.sessionManager.getSessionDir()`), which already
 * reflects `--session-dir`, PI_CODING_AGENT_SESSION_DIR and the `sessionDir`
 * setting. Pi's default is one folder per cwd under `<agentDir>/sessions`, so
 * that case reads the whole `<agentDir>/sessions`. An in-memory session
 * (`--no-session`) has no folder; then the env var, the setting and the
 * default are resolved here in Pi's order.
 */
export function resolveSessionsDir(
	agentDir: string,
	effectiveDir: string,
	sessionDirSetting?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const root = resolve(agentDir, "sessions");
	if (effectiveDir) return dirname(resolve(effectiveDir)) === root ? root : effectiveDir;
	const fromEnv = env.PI_CODING_AGENT_SESSION_DIR;
	if (fromEnv) return fromEnv === "~" ? homedir() : fromEnv.startsWith("~/") ? join(homedir(), fromEnv.slice(2)) : fromEnv;
	return sessionDirSetting || join(agentDir, "sessions");
}

export function usageCachePath(agentDir: string): string {
	return join(agentDir, "usage-extension-cache.json");
}

// =============================================================================
// Session file discovery
// =============================================================================

async function collectSessionFilesRecursively(dir: string, files: string[], signal?: AbortSignal): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (signal?.aborted) return;
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await collectSessionFilesRecursively(entryPath, files, signal);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	} catch {
		// Skip directories we can't read
	}
}

async function getAllSessionFiles(sessionsDir: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	await collectSessionFilesRecursively(sessionsDir, files, signal);
	files.sort();
	return files;
}

// =============================================================================
// Session file parsing
// =============================================================================

const NEWLINE = 0x0a;

// Relevance patterns for the buffer-level pre-filter. Pi writes compact JSON
// (`"role":"assistant"`), but imported/third-party session files have been seen
// with Python-style spaced JSON (`"role": "assistant"`), so both are matched.
// False positives (e.g. a tool result quoting one of these strings verbatim)
// only cost a wasted JSON.parse — the parsed entry is still shape-checked.
const PATTERN_ASSISTANT_COMPACT = Buffer.from('"role":"assistant"');
const PATTERN_ASSISTANT_SPACED = Buffer.from('"role": "assistant"');
const PATTERN_TOOL_RESULT_COMPACT = Buffer.from('"role":"toolResult"');
const PATTERN_TOOL_RESULT_SPACED = Buffer.from('"role": "toolResult"');
const PATTERN_USAGE_COMPACT = Buffer.from('"usage":{');
const PATTERN_USAGE_SPACED = Buffer.from('"usage": {');
const PATTERN_SESSION_COMPACT = Buffer.from('"type":"session"');
const PATTERN_SESSION_SPACED = Buffer.from('"type": "session"');
const PATTERN_THINKING_COMPACT = Buffer.from('"type":"thinking_level_change"');
const PATTERN_THINKING_SPACED = Buffer.from('"type": "thinking_level_change"');
const PATTERN_COMPACTION_COMPACT = Buffer.from('"type":"compaction"');
const PATTERN_COMPACTION_SPACED = Buffer.from('"type": "compaction"');
const PATTERN_BRANCH_SUMMARY_COMPACT = Buffer.from('"type":"branch_summary"');
const PATTERN_BRANCH_SUMMARY_SPACED = Buffer.from('"type": "branch_summary"');
// Pi 0.87 `appendUsage` entries, such as cache warming, carry their own provider and model.
const PATTERN_USAGE_ENTRY_COMPACT = Buffer.from('"type":"usage"');
const PATTERN_USAGE_ENTRY_SPACED = Buffer.from('"type": "usage"');
// pi-subagents versions predating Pi 0.81 persisted child usage in details but
// could not put it on the canonical tool-result usage field. Their tool names
// are near the start of the line, so we can recover those records without
// scanning every multi-megabyte tool result.
const PATTERN_SUBAGENT_TOOL_COMPACT = Buffer.from('"toolName":"subagent"');
const PATTERN_SUBAGENT_TOOL_SPACED = Buffer.from('"toolName": "subagent"');
const PATTERN_SUBAGENT_WAIT_TOOL_COMPACT = Buffer.from('"toolName":"subagent_wait"');
const PATTERN_SUBAGENT_WAIT_TOOL_SPACED = Buffer.from('"toolName": "subagent_wait"');

const PARSE_YIELD_EVERY_LINES = 2000;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Cost as recorded: a number, `{ total }`, or `{ input, output, cacheRead, cacheWrite }` without a total. */
export function parseCost(value: unknown): number {
	if (typeof value === "number") return finiteNumber(value);
	if (!value || typeof value !== "object") return 0;
	const parts = value as Record<string, unknown>;
	if (typeof parts.total === "number") return finiteNumber(parts.total);
	return finiteNumber(parts.input) + finiteNumber(parts.output) + finiteNumber(parts.cacheRead) + finiteNumber(parts.cacheWrite);
}

/** The one parser for every usage shape: assistant messages, tool results, compactions and summaries. */
export function parseUsageAmount(value: unknown): UsageAmount | null {
	if (!value || typeof value !== "object") return null;
	const persisted = value as Record<string, unknown>;
	const cost = parseCost(persisted.cost);
	const usage = {
		cost,
		input: finiteNumber(persisted.input),
		output: finiteNumber(persisted.output),
		cacheRead: finiteNumber(persisted.cacheRead),
		cacheWrite: finiteNumber(persisted.cacheWrite),
		reasoning: finiteNumber(persisted.reasoning),
	};
	// Null only when nothing at all was recorded: a reasoning-only record still counts.
	const empty = usage.cost === 0 && usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 &&
		usage.cacheWrite === 0 && usage.reasoning === 0;
	return empty ? null : usage;
}

function parsedTimestamp(messageTimestamp: unknown, entryTimestamp: unknown): number {
	const parsed =
		typeof messageTimestamp === "number"
			? messageTimestamp
			: new Date(String(messageTimestamp ?? entryTimestamp ?? "")).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}

function auxiliaryMessage(usage: UsageAmount, timestamp: number, sourceId: string): SessionMessage {
	return {
		provider: AUXILIARY_PROVIDER,
		model: AUXILIARY_MODEL,
		thinkingLevel: AUXILIARY_THINKING_LEVEL,
		source: "auxiliary",
		sourceId,
		...usage,
		timestamp,
	};
}

function buildToolUsageRecord(
	toolName: unknown,
	detailsValue: unknown,
	reportedValue: unknown,
	sourceIdValue: unknown,
	messageTimestamp: unknown,
	entryTimestamp: unknown
): ToolUsageRecord | null {
	const reportedUsage = parseUsageAmount(reportedValue);
	const details = detailsValue && typeof detailsValue === "object" ? (detailsValue as Record<string, unknown>) : null;
	const totalChildUsage = parseUsageAmount(details?.totalChildUsage);
	const knownNestedTool = toolName === "subagent" || toolName === "subagent_wait";
	const children: ChildToolUsage[] = [];
	if (details && Array.isArray(details.results)) {
		for (let resultIndex = 0; resultIndex < details.results.length; resultIndex++) {
			const result = details.results[resultIndex];
			if (!result || typeof result !== "object") continue;
			const child = result as Record<string, unknown>;
			const usage = parseUsageAmount(child.usage);
			const sessionFile = typeof child.sessionFile === "string" ? child.sessionFile : "";
			// Legacy fallback is deliberately restricted to recognised nested-agent
			// records. Generic Pi 0.81 tools remain canonical through reportedUsage.
			if (usage && (knownNestedTool || totalChildUsage || (reportedUsage && sessionFile))) {
				children.push({ resultIndex, sessionFile, usage });
			}
		}
	}
	if (!reportedUsage && children.length === 0) return null;
	return {
		sourceId: typeof sourceIdValue === "string" ? sourceIdValue : "",
		timestamp: parsedTimestamp(messageTimestamp, entryTimestamp),
		reportedUsage,
		runId: details && typeof details.runId === "string" ? details.runId : "",
		children,
	};
}

const LARGE_TOOL_RESULT_BYTES = 64 * 1024;
const PROPERTY_ID = Buffer.from('"id":');
const PROPERTY_TIMESTAMP = Buffer.from('"timestamp":');
const PROPERTY_MESSAGE = Buffer.from('"message":');
const PROPERTY_TOOL_NAME = Buffer.from('"toolName":');
const PROPERTY_DETAILS = Buffer.from('"details":');
const PROPERTY_USAGE = Buffer.from('"usage":');
const DIRECT_CHILD_PROPERTIES = new Set(["usage", "sessionFile"]);

function skipJsonWhitespace(buffer: Buffer, offset: number, limit: number): number {
	while (offset < limit && (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0a || buffer[offset] === 0x0d)) offset++;
	return offset;
}

/** Find one JSON value's end without decoding large strings or container bodies. */
function jsonValueEnd(buffer: Buffer, offset: number, limit: number): number {
	offset = skipJsonWhitespace(buffer, offset, limit);
	if (offset >= limit) return offset;
	const first = buffer[offset];
	if (first === 0x22) {
		let escaped = false;
		for (let i = offset + 1; i < limit; i++) {
			const byte = buffer[i];
			if (escaped) escaped = false;
			else if (byte === 0x5c) escaped = true;
			else if (byte === 0x22) return i + 1;
		}
		return limit;
	}
	if (first === 0x7b || first === 0x5b) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = offset; i < limit; i++) {
			const byte = buffer[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (byte === 0x5c) escaped = true;
				else if (byte === 0x22) inString = false;
				continue;
			}
			if (byte === 0x22) inString = true;
			else if (byte === 0x7b || byte === 0x5b) depth++;
			else if (byte === 0x7d || byte === 0x5d) {
				depth--;
				if (depth === 0) return i + 1;
			}
		}
		return limit;
	}
	let end = offset;
	while (end < limit && buffer[end] !== 0x2c && buffer[end] !== 0x5d && buffer[end] !== 0x7d) end++;
	return end;
}

function parseJsonValueAt(buffer: Buffer, offset: number, limit: number): unknown {
	const start = skipJsonWhitespace(buffer, offset, limit);
	const end = jsonValueEnd(buffer, start, limit);
	if (end <= start) return undefined;
	try {
		return JSON.parse(buffer.toString("utf8", start, end));
	} catch {
		return undefined;
	}
}

function parsePropertyValue(buffer: Buffer, property: Buffer, from: number, to: number): unknown {
	const propertyOffset = buffer.indexOf(property, from);
	if (propertyOffset < 0 || propertyOffset >= to) return undefined;
	return parseJsonValueAt(buffer, propertyOffset + property.length, to);
}

function parseLastPropertyValue(buffer: Buffer, property: Buffer, from: number, to: number): unknown {
	const propertyOffset = buffer.lastIndexOf(property, to - 1);
	if (propertyOffset < from) return undefined;
	return parseJsonValueAt(buffer, propertyOffset + property.length, to);
}

interface DirectObjectScan {
	end: number;
	values: Map<string, [start: number, end: number]>;
}

/** Scan direct object properties while skipping nested values allocation-free. */
function scanDirectObjectProperties(buffer: Buffer, objectStart: number, limit: number, wanted: Set<string>): DirectObjectScan {
	const values = new Map<string, [number, number]>();
	let cursor = objectStart + 1;
	while (cursor < limit) {
		cursor = skipJsonWhitespace(buffer, cursor, limit);
		if (buffer[cursor] === 0x7d) return { end: cursor + 1, values };
		if (buffer[cursor] === 0x2c) {
			cursor++;
			continue;
		}
		if (buffer[cursor] !== 0x22) return { end: jsonValueEnd(buffer, objectStart, limit), values };
		const keyEnd = jsonValueEnd(buffer, cursor, limit);
		let colon = skipJsonWhitespace(buffer, keyEnd, limit);
		if (buffer[colon] !== 0x3a) return { end: jsonValueEnd(buffer, objectStart, limit), values };
		const valueStart = skipJsonWhitespace(buffer, colon + 1, limit);
		const valueEnd = jsonValueEnd(buffer, valueStart, limit);
		const key = buffer.toString("utf8", cursor + 1, keyEnd - 1);
		if (wanted.has(key)) values.set(key, [valueStart, valueEnd]);
		if (valueEnd <= valueStart) return { end: limit, values };
		cursor = valueEnd;
	}
	return { end: limit, values };
}

function parseJsonRange(buffer: Buffer, range: [number, number] | undefined): unknown {
	if (!range) return undefined;
	try {
		return JSON.parse(buffer.toString("utf8", range[0], range[1]));
	} catch {
		return undefined;
	}
}

interface ChildResultsScan {
	end: number;
	results: Array<Record<string, unknown>>;
}

function scanChildResults(buffer: Buffer, arrayStart: number, limit: number): ChildResultsScan {
	const results: Array<Record<string, unknown>> = [];
	let cursor = arrayStart + 1;
	while (cursor < limit) {
		cursor = skipJsonWhitespace(buffer, cursor, limit);
		if (buffer[cursor] === 0x5d) return { end: cursor + 1, results };
		if (buffer[cursor] === 0x2c) {
			cursor++;
			continue;
		}
		if (buffer[cursor] === 0x7b) {
			const scanned = scanDirectObjectProperties(buffer, cursor, limit, DIRECT_CHILD_PROPERTIES);
			results.push({
				usage: parseJsonRange(buffer, scanned.values.get("usage")),
				sessionFile: parseJsonRange(buffer, scanned.values.get("sessionFile")),
			});
			if (scanned.end <= cursor) return { end: limit, results };
			cursor = scanned.end;
			continue;
		}
		const valueEnd = jsonValueEnd(buffer, cursor, limit);
		if (valueEnd <= cursor) return { end: limit, results };
		cursor = valueEnd;
	}
	return { end: limit, results };
}

interface LargeDetailsScan {
	end: number;
	details: Record<string, unknown>;
}

/** Scan nested-agent details and its result metadata in a single byte pass. */
function scanLargeDetails(buffer: Buffer, objectStart: number, limit: number): LargeDetailsScan {
	const details: Record<string, unknown> = { results: [] };
	let cursor = objectStart + 1;
	while (cursor < limit) {
		cursor = skipJsonWhitespace(buffer, cursor, limit);
		if (buffer[cursor] === 0x7d) return { end: cursor + 1, details };
		if (buffer[cursor] === 0x2c) {
			cursor++;
			continue;
		}
		if (buffer[cursor] !== 0x22) return { end: jsonValueEnd(buffer, objectStart, limit), details };
		const keyEnd = jsonValueEnd(buffer, cursor, limit);
		let colon = skipJsonWhitespace(buffer, keyEnd, limit);
		if (buffer[colon] !== 0x3a) return { end: jsonValueEnd(buffer, objectStart, limit), details };
		const valueStart = skipJsonWhitespace(buffer, colon + 1, limit);
		const key = buffer.toString("utf8", cursor + 1, keyEnd - 1);
		let valueEnd: number;
		if (key === "results" && buffer[valueStart] === 0x5b) {
			const scanned = scanChildResults(buffer, valueStart, limit);
			details.results = scanned.results;
			valueEnd = scanned.end;
		} else {
			valueEnd = jsonValueEnd(buffer, valueStart, limit);
			if (key === "runId" || key === "totalChildUsage") {
				details[key] = parseJsonRange(buffer, [valueStart, valueEnd]);
			}
		}
		if (valueEnd <= valueStart) return { end: limit, details };
		cursor = valueEnd;
	}
	return { end: limit, details };
}

/**
 * Parse only the small accounting fields from a large tool-result line. This
 * avoids UTF-8 decoding and JSON.parse allocation for multi-megabyte content.
 */
function parseLargeToolResultLine(line: Buffer): ToolUsageRecord | null {
	const messageOffset = line.indexOf(PROPERTY_MESSAGE);
	if (messageOffset < 0) return null;
	const detailsOffset = line.indexOf(PROPERTY_DETAILS, messageOffset);
	let detailsEnd = -1;
	let details: Record<string, unknown> | null = null;
	if (detailsOffset >= 0) {
		const detailsStart = skipJsonWhitespace(line, detailsOffset + PROPERTY_DETAILS.length, line.length);
		if (line[detailsStart] === 0x7b) {
			const scanned = scanLargeDetails(line, detailsStart, line.length);
			detailsEnd = scanned.end;
			details = scanned.details;
		}
	}

	const reportedUsage = detailsEnd >= 0
		? parsePropertyValue(line, PROPERTY_USAGE, detailsEnd, line.length)
		: parseLastPropertyValue(line, PROPERTY_USAGE, messageOffset, line.length);
	const sourceId = parsePropertyValue(line, PROPERTY_ID, 0, messageOffset);
	const entryTimestamp = parsePropertyValue(line, PROPERTY_TIMESTAMP, 0, messageOffset);
	const messageTimestamp = parseLastPropertyValue(line, PROPERTY_TIMESTAMP, messageOffset, line.length);
	const toolName = parsePropertyValue(line, PROPERTY_TOOL_NAME, messageOffset, detailsOffset >= 0 ? detailsOffset : line.length);
	return buildToolUsageRecord(toolName, details, reportedUsage, sourceId, messageTimestamp, entryTimestamp);
}

function lineMightBeRelevant(line: Buffer): boolean {
	// Entry type/role fields are at the front of Pi's JSONL objects. Restrict
	// those checks to a small prefix so multi-megabyte tool output is not scanned
	// repeatedly for every possible entry shape.
	const head = line.length > 1024 ? line.subarray(0, 1024) : line;
	if (head.includes(PATTERN_ASSISTANT_COMPACT) || head.includes(PATTERN_ASSISTANT_SPACED)) return true;

	if (head.includes(PATTERN_TOOL_RESULT_COMPACT) || head.includes(PATTERN_TOOL_RESULT_SPACED)) {
		if (
			head.includes(PATTERN_SUBAGENT_TOOL_COMPACT) ||
			head.includes(PATTERN_SUBAGENT_TOOL_SPACED) ||
			head.includes(PATTERN_SUBAGENT_WAIT_TOOL_COMPACT) ||
			head.includes(PATTERN_SUBAGENT_WAIT_TOOL_SPACED)
		) {
			return true;
		}
		// Pi serializes optional tool usage after content/details and immediately
		// before the small isError/timestamp suffix. Checking the tail preserves
		// the fast path for ordinary tool results, which dominate session bytes.
		const tail = line.length > 4096 ? line.subarray(line.length - 4096) : line;
		return tail.includes(PATTERN_USAGE_COMPACT) || tail.includes(PATTERN_USAGE_SPACED);
	}

	return (
		head.includes(PATTERN_SESSION_COMPACT) ||
		head.includes(PATTERN_THINKING_COMPACT) ||
		head.includes(PATTERN_COMPACTION_COMPACT) ||
		head.includes(PATTERN_BRANCH_SUMMARY_COMPACT) ||
		head.includes(PATTERN_SESSION_SPACED) ||
		head.includes(PATTERN_THINKING_SPACED) ||
		head.includes(PATTERN_COMPACTION_SPACED) ||
		head.includes(PATTERN_BRANCH_SUMMARY_SPACED) ||
		head.includes(PATTERN_USAGE_ENTRY_COMPACT) ||
		head.includes(PATTERN_USAGE_ENTRY_SPACED)
	);
}

/**
 * Extract the session id plus assistant/tool/summary usage from a JSONL buffer.
 * Returns partial results when aborted — callers must check `signal.aborted`
 * before caching or using the result.
 */
export async function parseSessionBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	const messages: SessionMessage[] = [];
	const toolUsages: ToolUsageRecord[] = [];
	let sessionId = "";
	let cwd = "";
	// Assistant messages don't carry the thinking level; pi records it as separate
	// thinking_level_change entries, always written before the first assistant
	// message of a session. Replaying them in append order attributes each message
	// to the level active when it was produced.
	let thinkingLevel = "";

	let start = 0;
	let lineNumber = 0;

	while (start < buffer.length) {
		let end = buffer.indexOf(NEWLINE, start);
		if (end === -1) end = buffer.length;

		lineNumber++;
		if (lineNumber % PARSE_YIELD_EVERY_LINES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (signal?.aborted) return { sessionId, cwd, messages, toolUsages };
		}

		const lineBuffer = buffer.subarray(start, end);
		if (end > start && lineMightBeRelevant(lineBuffer)) {
			const head = lineBuffer.subarray(0, Math.min(1024, lineBuffer.length));
			if (lineBuffer.length > LARGE_TOOL_RESULT_BYTES && head.includes(PATTERN_TOOL_RESULT_COMPACT)) {
				const toolUsage = parseLargeToolResultLine(lineBuffer);
				if (toolUsage) toolUsages.push(toolUsage);
				start = end + 1;
				continue;
			}
			try {
				const entry = JSON.parse(buffer.toString("utf8", start, end));

				if (entry.type === "session") {
					sessionId = entry.id;
					if (typeof entry.cwd === "string") cwd = entry.cwd;
				} else if (entry.type === "thinking_level_change") {
					if (typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
				} else if (entry.type === "compaction" || entry.type === "branch_summary") {
					const usage = parseUsageAmount(entry.usage);
					if (usage) messages.push(auxiliaryMessage(usage, parsedTimestamp(undefined, entry.timestamp), typeof entry.id === "string" ? entry.id : ""));
				} else if (entry.type === "usage") {
					const usage = typeof entry.provider === "string" && typeof entry.model === "string"
						? parseUsageAmount(entry.usage)
						: null;
					if (usage) {
						messages.push({
							provider: entry.provider,
							model: entry.model,
							thinkingLevel,
							source: "auxiliary",
							sourceId: typeof entry.id === "string" ? entry.id : "",
							...usage,
							timestamp: parsedTimestamp(undefined, entry.timestamp),
						});
					}
				} else if (entry.type === "message" && entry.message?.role === "assistant") {
					const msg = entry.message;
					// A message that recorded no usage at all (an aborted /context probe, for
					// one) billed nothing, so it is neither a turn nor a cost.
					const usage = msg.provider && msg.model ? parseUsageAmount(msg.usage) : null;
					if (usage) {
						messages.push({
							provider: msg.provider,
							model: msg.model,
							thinkingLevel,
							source: "assistant",
							sourceId: "",
							...usage,
							timestamp: parsedTimestamp(msg.timestamp, entry.timestamp),
						});
					}
				} else if (entry.type === "message" && entry.message?.role === "toolResult") {
					const msg = entry.message;
					const toolUsage = buildToolUsageRecord(msg.toolName, msg.details, msg.usage, entry.id, msg.timestamp, entry.timestamp);
					if (toolUsage) toolUsages.push(toolUsage);
				}
			} catch {
				// Skip malformed lines
			}
		}

		start = end + 1;
	}

	return { sessionId, cwd, messages, toolUsages };
}

// =============================================================================
// On-disk cache
// =============================================================================

// Upstream's version 6 tuple layout, unchanged. The version is bumped because
// the parser now counts what version 6 dropped (costs in other shapes,
// reasoning-only records, `usage` entries), so version 6 entries are reparsed.
const CACHE_VERSION = 7;

type CachedMessageTuple = [
	providerIdx: number,
	modelIdx: number,
	cost: number,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	timestamp: number,
	thinkingLevelIdx: number,
	reasoning: number,
	unused: 0 | 1, // was afterContextChange, read only by the cut Insights view
	auxiliary: 0 | 1,
	sourceIdIdx: number,
];

type CachedUsageTuple = [
	cost: number,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	reasoning: number,
];

type CachedChildToolUsageTuple = [
	resultIndex: number,
	sessionFileIdx: number,
	usage: CachedUsageTuple,
];

type CachedToolUsageTuple = [
	sourceIdIdx: number,
	timestamp: number,
	reportedUsage: CachedUsageTuple | null,
	runIdIdx: number,
	children: CachedChildToolUsageTuple[],
];

interface CacheFileEntry {
	size: number;
	mtimeMs: number;
	sessionId: string;
	cwd: string;
	messages: CachedMessageTuple[];
	toolUsages: CachedToolUsageTuple[];
}

export interface CachedFileState {
	size: number;
	mtimeMs: number;
	parsed: ParsedSessionFile;
}

export async function loadUsageCache(cachePath: string): Promise<Map<string, CachedFileState>> {
	const result = new Map<string, CachedFileState>();
	let raw: { version?: unknown; names?: unknown; files?: unknown };
	try {
		raw = JSON.parse(await readFile(cachePath, "utf8"));
	} catch {
		return result; // Missing or corrupt cache — rebuild from scratch.
	}
	if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.names) || typeof raw.files !== "object" || raw.files === null) {
		return result;
	}

	const names = raw.names as unknown[];
	for (const [filePath, entry] of Object.entries(raw.files as Record<string, CacheFileEntry>)) {
		if (
			!entry ||
			typeof entry.size !== "number" ||
			typeof entry.mtimeMs !== "number" ||
			typeof entry.sessionId !== "string" ||
			typeof entry.cwd !== "string" ||
			!Array.isArray(entry.messages) ||
			!Array.isArray(entry.toolUsages)
		) {
			continue;
		}
		const messages: SessionMessage[] = [];
		let valid = true;
		for (const tuple of entry.messages) {
			if (!Array.isArray(tuple) || tuple.length !== 13) {
				valid = false;
				break;
			}
			const provider = names[tuple[0]];
			const model = names[tuple[1]];
			const thinkingLevel = names[tuple[8]];
			const sourceId = names[tuple[12]];
			if (
				typeof provider !== "string" ||
				typeof model !== "string" ||
				typeof thinkingLevel !== "string" ||
				typeof sourceId !== "string" ||
				(tuple[11] !== 0 && tuple[11] !== 1)
			) {
				valid = false;
				break;
			}
			messages.push({
				provider,
				model,
				thinkingLevel,
				source: tuple[11] === 1 ? "auxiliary" : "assistant",
				sourceId,
				cost: Number(tuple[2]) || 0,
				input: Number(tuple[3]) || 0,
				output: Number(tuple[4]) || 0,
				cacheRead: Number(tuple[5]) || 0,
				cacheWrite: Number(tuple[6]) || 0,
				timestamp: Number(tuple[7]) || 0,
				reasoning: Number(tuple[9]) || 0,
			});
		}
		if (!valid) continue;
		const toolUsages: ToolUsageRecord[] = [];
		for (const tuple of entry.toolUsages) {
			if (!Array.isArray(tuple) || tuple.length !== 5 || !Array.isArray(tuple[4])) {
				valid = false;
				break;
			}
			const sourceId = names[tuple[0]];
			const runId = names[tuple[3]];
			const reportedUsage = cachedUsageAmount(tuple[2]);
			if (typeof sourceId !== "string" || typeof runId !== "string" || (tuple[2] !== null && !reportedUsage)) {
				valid = false;
				break;
			}
			const children: ChildToolUsage[] = [];
			for (const childTuple of tuple[4]) {
				if (!Array.isArray(childTuple) || childTuple.length !== 3) {
					valid = false;
					break;
				}
				const sessionFile = names[childTuple[1]];
				const usage = cachedUsageAmount(childTuple[2]);
				if (typeof childTuple[0] !== "number" || typeof sessionFile !== "string" || !usage) {
					valid = false;
					break;
				}
				children.push({ resultIndex: childTuple[0], sessionFile, usage });
			}
			if (!valid) break;
			toolUsages.push({
				sourceId,
				timestamp: Number(tuple[1]) || 0,
				reportedUsage,
				runId,
				children,
			});
		}
		if (!valid) continue;
		result.set(filePath, {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			parsed: { sessionId: entry.sessionId, cwd: entry.cwd, messages, toolUsages },
		});
	}
	return result;
}

function cachedUsageAmount(value: unknown): UsageAmount | null {
	if (!Array.isArray(value) || value.length !== 6 || value.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
		return null;
	}
	return {
		cost: value[0],
		input: value[1],
		output: value[2],
		cacheRead: value[3],
		cacheWrite: value[4],
		reasoning: value[5],
	};
}

function cacheUsageAmount(usage: UsageAmount): CachedUsageTuple {
	return [usage.cost, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning];
}

export async function saveUsageCache(cachePath: string, states: Map<string, CachedFileState>): Promise<void> {
	const names: string[] = [];
	const nameIndex = new Map<string, number>();
	const intern = (name: string): number => {
		let idx = nameIndex.get(name);
		if (idx === undefined) {
			idx = names.length;
			names.push(name);
			nameIndex.set(name, idx);
		}
		return idx;
	};

	const files: Record<string, CacheFileEntry> = {};
	for (const [filePath, state] of states) {
		files[filePath] = {
			size: state.size,
			mtimeMs: state.mtimeMs,
			sessionId: state.parsed.sessionId,
			cwd: state.parsed.cwd,
			messages: state.parsed.messages.map((m): CachedMessageTuple => [
				intern(m.provider),
				intern(m.model),
				m.cost,
				m.input,
				m.output,
				m.cacheRead,
				m.cacheWrite,
				m.timestamp,
				intern(m.thinkingLevel),
				m.reasoning,
				0,
				m.source === "auxiliary" ? 1 : 0,
				intern(m.source === "auxiliary" ? m.sourceId : ""),
			]),
			toolUsages: state.parsed.toolUsages.map((tool): CachedToolUsageTuple => [
				intern(tool.sourceId),
				tool.timestamp,
				tool.reportedUsage ? cacheUsageAmount(tool.reportedUsage) : null,
				intern(tool.runId),
				tool.children.map((child): CachedChildToolUsageTuple => [
					child.resultIndex,
					intern(child.sessionFile),
					cacheUsageAmount(child.usage),
				]),
			]),
		};
	}

	const payload = JSON.stringify({ version: CACHE_VERSION, names, files });
	// Atomic-ish write: concurrent /usage runs race to a last-writer-wins rename
	// instead of interleaving partial writes.
	const tmpPath = join(dirname(cachePath), `.usage-cache-${process.pid}-${Date.now()}.tmp`);
	await writeFile(tmpPath, payload, "utf8");
	await rename(tmpPath, cachePath);
}

// =============================================================================
// Aggregation
// =============================================================================

function emptyTokens(): TokenStats {
	return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyModelStats(): ModelStats {
	return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
}

function emptyProviderStats(): ProviderStats {
	return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens(), models: new Map() };
}

function emptyTimeFilteredStats(): TimeFilteredStats {
	return {
		providers: new Map(),
		totals: { sessions: 0, messages: 0, cost: 0, tokens: emptyTokens() },
	};
}

function emptyUsageData(bounds: PeriodBounds): UsageData {
	return {
		today: emptyTimeFilteredStats(),
		thisWeek: emptyTimeFilteredStats(),
		lastWeek: emptyTimeFilteredStats(),
		last30Days: emptyTimeFilteredStats(),
		allTime: emptyTimeFilteredStats(),
		hourly: new Map(),
		bounds,
	};
}

/**
 * Start of the local hour holding `ms`: the same local clock the period bounds
 * use. Subtracting the local minutes keeps both 01:00 hours of a DST fall-back
 * apart; setting the minutes to 0 would resolve both to the first.
 */
export function localHourStart(ms: number): number {
	const d = new Date(ms);
	return ms - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds());
}

function addToHourlyBuckets(hourly: Map<number, Map<HourlyKey, HourlyCell>>, msg: SessionMessage): void {
	if (msg.timestamp <= 0) return; // Unknown time can't be placed on a time axis.
	const hour = localHourStart(msg.timestamp);
	let bucket = hourly.get(hour);
	if (!bucket) {
		bucket = new Map();
		hourly.set(hour, bucket);
	}
	const key = makeHourlyKey(msg.provider, msg.model, msg.thinkingLevel);
	let cell = bucket.get(key);
	if (!cell) {
		cell = { messages: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
		bucket.set(key, cell);
	}
	if (msg.source === "assistant") cell.messages++;
	cell.cost += msg.cost;
	cell.input += msg.input;
	cell.output += msg.output;
	cell.cacheRead += msg.cacheRead;
	cell.cacheWrite += msg.cacheWrite;
	cell.reasoning += msg.reasoning;
}

function accumulateStats(target: BaseStats, cost: number, tokens: TokenStats, countMessage: boolean): void {
	if (countMessage) target.messages++;
	target.cost += cost;
	target.tokens.total += tokens.total;
	target.tokens.input += tokens.input;
	target.tokens.output += tokens.output;
	target.tokens.cacheRead += tokens.cacheRead;
	target.tokens.cacheWrite += tokens.cacheWrite;
}

function getPeriodsForTimestamp(timestamp: number, bounds: PeriodBounds): TabName[] {
	const periods: TabName[] = ["allTime"];
	if (timestamp >= bounds.todayMs) periods.push("today");
	if (timestamp >= bounds.weekStartMs) {
		periods.push("thisWeek");
	} else if (timestamp >= bounds.lastWeekStartMs) {
		periods.push("lastWeek");
	}
	if (timestamp >= bounds.last30DaysStartMs) periods.push("last30Days");
	return periods;
}

/** pi's built-in test providers never send anything to a real API. */
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);

function addMessagesToUsageData(data: UsageData, sessionId: string, messages: SessionMessage[]): void {
	const sessionContributed = new Set<TabName>();
	for (const msg of messages) {
		if (EXCLUDED_PROVIDERS.has(msg.provider)) continue;
		addToHourlyBuckets(data.hourly, msg);
		const tokens: TokenStats = {
			// Fresh tokens: cacheWrite was newly written and billed; cacheRead
			// is excluded because repeated cache hits would dominate totals.
			total: msg.input + msg.output + msg.cacheWrite,
			input: msg.input,
			output: msg.output,
			cacheRead: msg.cacheRead,
			cacheWrite: msg.cacheWrite,
		};
		const isAssistant = msg.source === "assistant";
		for (const period of getPeriodsForTimestamp(msg.timestamp, data.bounds)) {
			const stats = data[period];
			let providerStats = stats.providers.get(msg.provider);
			if (!providerStats) {
				providerStats = emptyProviderStats();
				stats.providers.set(msg.provider, providerStats);
			}
			let modelStats = providerStats.models.get(msg.model);
			if (!modelStats) {
				modelStats = emptyModelStats();
				providerStats.models.set(msg.model, modelStats);
			}
			modelStats.sessions.add(sessionId);
			accumulateStats(modelStats, msg.cost, tokens, isAssistant);
			providerStats.sessions.add(sessionId);
			accumulateStats(providerStats, msg.cost, tokens, isAssistant);
			accumulateStats(stats.totals, msg.cost, tokens, isAssistant);
			sessionContributed.add(period);
		}
	}
	for (const period of sessionContributed) data[period].totals.sessions++;
}

// =============================================================================
// Nested tool-usage accounting
// =============================================================================

// Recognised nested-agent tool results report usage for child runs that
// pi-subagents also persists as ordinary session files, which this scan
// already counts with full model attribution. When every child session file
// behind a report is part of the scan, the children speak for themselves and
// the parent's aggregate is skipped. Otherwise the aggregate (or, for pre-0.81
// legacy entries, each unresolved child's reported usage) is counted under
// Tools / summaries.
//
// Copied branch history gets a new parent filename, so a copy's runId-derived
// child paths can dangle even though the original's resolve. Resolved child
// identities are therefore unioned across all copies of an entry before any
// emission, and identical emissions collapse in the sourceId dedupe.

interface ScannedSessionIndex {
	/** Resolved paths of scanned files that have a session header. */
	paths: Set<string>;
	/** Directory of each scanned file → number of scanned files inside it. */
	fileCountByDir: Map<string, number>;
}

function buildScannedSessionIndex(states: Map<string, CachedFileState>): ScannedSessionIndex {
	const paths = new Set<string>();
	const fileCountByDir = new Map<string, number>();
	for (const [filePath, state] of states) {
		if (!state.parsed.sessionId) continue;
		const resolved = resolve(filePath);
		paths.add(resolved);
		const dir = dirname(resolved);
		fileCountByDir.set(dir, (fileCountByDir.get(dir) ?? 0) + 1);
	}
	return { paths, fileCountByDir };
}

function childSessionScanned(
	parentFilePath: string,
	tool: ToolUsageRecord,
	child: ChildToolUsage,
	index: ScannedSessionIndex
): boolean {
	if (child.sessionFile) {
		const explicit = isAbsolute(child.sessionFile)
			? resolve(child.sessionFile)
			: resolve(dirname(parentFilePath), child.sessionFile);
		if (index.paths.has(explicit)) return true;
	}
	if (tool.runId) {
		const runDir = resolve(dirname(parentFilePath), basename(parentFilePath, ".jsonl"), tool.runId, `run-${child.resultIndex}`);
		// The run directory holds exactly one session per child run, so either the
		// conventional name or a lone scanned file inside it identifies the child.
		if (index.paths.has(join(runDir, "session.jsonl"))) return true;
		if (index.fileCountByDir.get(runDir) === 1) return true;
	}
	return false;
}

/** Identity of one child slot of one tool entry, stable across copied history. */
function toolChildIdentity(tool: ToolUsageRecord, child: ChildToolUsage): string {
	const fingerprint = child.usage.input + child.usage.output + child.usage.cacheRead + child.usage.cacheWrite;
	return `${tool.sourceId}:${tool.timestamp}:${child.resultIndex}:${fingerprint}`;
}

function resolvedToolChildIdentities(states: Map<string, CachedFileState>, index: ScannedSessionIndex): Set<string> {
	const resolved = new Set<string>();
	for (const [filePath, state] of states) {
		for (const tool of state.parsed.toolUsages) {
			if (!tool.sourceId) continue;
			for (const child of tool.children) {
				if (childSessionScanned(filePath, tool, child, index)) resolved.add(toolChildIdentity(tool, child));
			}
		}
	}
	return resolved;
}

function toolUsageMessages(
	parentFilePath: string,
	tool: ToolUsageRecord,
	index: ScannedSessionIndex,
	resolvedChildren: Set<string>
): SessionMessage[] {
	const scanned = (child: ChildToolUsage) =>
		childSessionScanned(parentFilePath, tool, child, index) ||
		(tool.sourceId !== "" && resolvedChildren.has(toolChildIdentity(tool, child)));
	if (tool.reportedUsage) {
		if (tool.children.length > 0 && tool.children.every(scanned)) return [];
		return [auxiliaryMessage(tool.reportedUsage, tool.timestamp, tool.sourceId)];
	}
	// Before Pi 0.81, recognised nested-agent tools persisted per-child usage in
	// details only. Count just the children whose sessions this scan cannot see.
	return tool.children
		.filter((child) => !scanned(child))
		.map((child) => auxiliaryMessage(child.usage, tool.timestamp, tool.sourceId ? `${tool.sourceId}:child:${child.resultIndex}` : ""));
}
// =============================================================================
// Collection orchestration
// =============================================================================

const STAT_CONCURRENCY = 16;
const DEFAULT_PARSE_CONCURRENCY = 4;
const AGGREGATE_YIELD_EVERY_FILES = 200;
const PROGRESS_REPORT_EVERY = 100;

export interface CollectProgress {
	/** Why this pass needs to parse files. */
	mode: "first-run" | "rebuild" | "update";
	/** Session files that need parsing this pass (0 = fully warm). */
	filesToParse: number;
	/** Files parsed so far; reported in coarse increments. */
	filesParsed: number;
	/** Newest session activity already ingested (ms since epoch); null when starting fresh. */
	sinceMs: number | null;
}

export interface CollectUsageOptions {
	signal?: AbortSignal;
	/** Called once before parsing begins and periodically while files are parsed. */
	onProgress?: (progress: CollectProgress) => void;
	/** From resolveSessionsDir. */
	sessionsDir: string;
	/** From usageCachePath; `null` disables the on-disk cache. */
	cachePath: string | null;
	/** Reference time for period bucketing. Defaults to `new Date()`. */
	now?: Date;
	parseConcurrency?: number;
}

export async function collectUsageData(options: CollectUsageOptions): Promise<UsageData | null> {
	const signal = options.signal;
	const now = options.now ?? new Date();
	const { sessionsDir, cachePath } = options;
	const parseConcurrency = Math.max(1, options.parseConcurrency ?? DEFAULT_PARSE_CONCURRENCY);

	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const todayMs = startOfToday.getTime();

	// Start of current week (Monday 00:00)
	const startOfWeek = new Date(now);
	const dayOfWeek = startOfWeek.getDay(); // 0 = Sunday, 1 = Monday, ...
	const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	startOfWeek.setDate(startOfWeek.getDate() - daysSinceMonday);
	startOfWeek.setHours(0, 0, 0, 0);
	const weekStartMs = startOfWeek.getTime();

	// Start of last week (previous Monday 00:00)
	const startOfLastWeek = new Date(startOfWeek);
	startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
	const lastWeekStartMs = startOfLastWeek.getTime();

	// Rolling 30-day window: the last 30 calendar days including today,
	// i.e. from midnight 29 days before today. setDate handles DST correctly.
	const startOfLast30Days = new Date(startOfToday);
	startOfLast30Days.setDate(startOfLast30Days.getDate() - 29);
	const last30DaysStartMs = startOfLast30Days.getTime();

	// 1. Discover session files.
	const filePaths = await getAllSessionFiles(sessionsDir, signal);
	if (signal?.aborted) return null;

	// 2. Stat them (batched) so cache freshness can be checked without reading contents.
	const fileStats = new Map<string, { size: number; mtimeMs: number }>();
	{
		let next = 0;
		await Promise.all(
			Array.from({ length: STAT_CONCURRENCY }, async () => {
				while (next < filePaths.length) {
					if (signal?.aborted) return;
					const filePath = filePaths[next++]!;
					try {
						const st = await stat(filePath);
						fileStats.set(filePath, { size: st.size, mtimeMs: st.mtimeMs });
					} catch {
						// File vanished between listing and stat — skip it.
					}
				}
			})
		);
	}
	if (signal?.aborted) return null;

	// 3. Load the cache and decide which files actually need parsing.
	let cacheFileExists = false;
	if (cachePath) {
		try {
			await stat(cachePath);
			cacheFileExists = true;
		} catch {
			// No cache file yet — first run.
		}
	}
	const previous = cachePath ? await loadUsageCache(cachePath) : new Map<string, CachedFileState>();
	if (signal?.aborted) return null;
	const current = new Map<string, CachedFileState>();
	const toParse: string[] = [];
	for (const filePath of filePaths) {
		const st = fileStats.get(filePath);
		if (!st) continue;
		const cached = previous.get(filePath);
		if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
			current.set(filePath, cached);
		} else {
			toParse.push(filePath);
		}
	}
	let dirty = toParse.length > 0;
	if (!dirty) {
		for (const filePath of previous.keys()) {
			if (!fileStats.has(filePath)) {
				dirty = true; // A cached file was deleted — evict it by rewriting.
				break;
			}
		}
	}

	// Progress reporting: distinguish a true first run from a format-change
	// rebuild (cache file present but unusable) and a routine incremental update.
	const progressMode: CollectProgress["mode"] =
		previous.size > 0 ? "update" : cacheFileExists ? "rebuild" : "first-run";
	let sinceMs: number | null = null;
	if (progressMode === "update") {
		for (const state of previous.values()) {
			if (state.mtimeMs > (sinceMs ?? 0)) sinceMs = state.mtimeMs;
		}
	}
	let filesParsed = 0;
	const reportProgress = (): void => {
		options.onProgress?.({ mode: progressMode, filesToParse: toParse.length, filesParsed, sinceMs });
	};
	reportProgress();

	// 4. Parse new/changed files with bounded concurrency.
	{
		let next = 0;
		await Promise.all(
			Array.from({ length: parseConcurrency }, async () => {
				while (next < toParse.length) {
					if (signal?.aborted) return;
					const filePath = toParse[next++]!;
					const st = fileStats.get(filePath)!;
					let buffer: Buffer;
					try {
						buffer = await readFile(filePath);
					} catch {
						filesParsed++;
						continue; // File vanished — skip it.
					}
					const parsed = await parseSessionBuffer(buffer, signal);
					if (signal?.aborted) return; // Never cache a partial parse.
					current.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, parsed });
					filesParsed++;
					if (filesParsed % PROGRESS_REPORT_EVERY === 0 || filesParsed === toParse.length) {
						reportProgress();
					}
				}
			})
		);
	}

	if (signal?.aborted) {
		// Best effort: persist whatever finished so a cancelled cold build makes
		// the next attempt cheaper. Keep old entries for files not processed yet —
		// they are re-validated against size/mtime next run anyway.
		if (cachePath && dirty && current.size > 0) {
			const merged = new Map(previous);
			for (const [filePath, state] of current) merged.set(filePath, state);
			await saveUsageCache(cachePath, merged).catch(() => {});
		}
		return null;
	}

	// 5. Persist the refreshed cache (also evicts entries for deleted files).
	if (cachePath && dirty) {
		await saveUsageCache(cachePath, current).catch(() => {
			// Cache write failures must never break /usage.
		});
	}

	// 6. Aggregate in sorted path order with cross-file dedupe.
	const data = emptyUsageData({ todayMs, weekStartMs, lastWeekStartMs, last30DaysStartMs, nowMs: now.getTime() });
	const seenHashes = new Set<string>();
	const scannedSessions = buildScannedSessionIndex(current);
	const resolvedToolChildren = resolvedToolChildIdentities(current, scannedSessions);
	let processedFiles = 0;

	for (const filePath of filePaths) {
		const state = current.get(filePath);
		if (!state || !state.parsed.sessionId) continue;

		if (++processedFiles % AGGREGATE_YIELD_EVERY_FILES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (signal?.aborted) return null;
		}

		// Deduplicate history copied across branched session files.
		const toolMessages = state.parsed.toolUsages.flatMap((tool) => toolUsageMessages(filePath, tool, scannedSessions, resolvedToolChildren));
		const rawMsgs = toolMessages.length > 0 ? [...state.parsed.messages, ...toolMessages] : state.parsed.messages;
		const deduped: SessionMessage[] = [];
		for (const m of rawMsgs) {
			// Pi entry ids survive copied branch history and distinguish parallel
			// tool results that happen to report identical usage in the same ms.
			const tokenFingerprint = m.input + m.output + m.cacheRead + m.cacheWrite;
			const hash =
				m.source === "auxiliary" && m.sourceId
					? `auxiliary:${m.sourceId}:${m.timestamp}:${tokenFingerprint}`
					: `${m.source}:${m.timestamp}:${tokenFingerprint}`;
			if (seenHashes.has(hash)) continue;
			seenHashes.add(hash);
			deduped.push(m);
		}
		if (deduped.length > 0) addMessagesToUsageData(data, state.parsed.sessionId, deduped);
	}

	return data;
}
