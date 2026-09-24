/**
 * Data collection and caching for the /usage dashboard.
 *
 * Performance model (upstream CHANGELOG 0.4.0):
 * - Session JSONL files are scanned at the buffer level. Only lines relevant
 *   to assistant or auxiliary accounting are decoded and JSON.parsed, so
 *   ordinary multi-megabyte tool results are skipped.
 * - Per-file extraction results are persisted to an on-disk cache keyed by
 *   (size, mtimeMs). Session files are append-only, so a warm load only
 *   re-parses files that changed since the last run.
 */

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

interface TokenStats {
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

interface ModelStats extends BaseStats {
	sessions: Set<string>;
}

interface ProviderStats extends BaseStats {
	sessions: Set<string>;
	models: Map<string, ModelStats>;
}

interface TotalStats extends BaseStats {
	sessions: number;
}

interface TimeFilteredStats {
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

const HOURLY_KEY_SEP = "\u0000";

function makeHourlyKey(provider: string, model: string, thinkingLevel: string): HourlyKey {
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

type UsageSource = "assistant" | "auxiliary";

/** Pi's own label for usage that cannot be attributed to a provider/model. */
const AUXILIARY_PROVIDER = "Tools";
const AUXILIARY_MODEL = "summaries";
const AUXILIARY_THINKING_LEVEL = "Tools/summaries";

interface UsageAmount {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

interface SessionMessage extends UsageAmount {
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

interface ParsedSessionFile {
	/** Empty string when the file has no session header — such files are ignored. */
	sessionId: string;
	/** Working directory from the session header; "" when absent. */
	cwd: string;
	/** Extracted assistant, tool and summary usage records, pre-dedupe. */
	messages: SessionMessage[];
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
const PARSE_YIELD_EVERY_LINES = 2000;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Cost as recorded: a number, `{ total }`, or `{ input, output, cacheRead, cacheWrite }` without a total. */
function parseCost(value: unknown): number {
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

const RELEVANT_ENTRY = /"(?:type|role)": ?"(?:assistant|toolResult|session|thinking_level_change|compaction|branch_summary|usage)"/;

// Entry type and role come first in Pi's JSONL lines, and a tool result's
// optional usage comes last, so neither check scans multi-megabyte tool output.
// A false positive only costs a JSON.parse; the parsed entry is still shape-checked.
function lineMightBeRelevant(line: Buffer): boolean {
	const match = RELEVANT_ENTRY.exec(line.toString("latin1", 0, 1024));
	if (!match) return false;
	return !match[0].endsWith('toolResult"') || /"usage": ?\{/.test(line.toString("latin1", Math.max(0, line.length - 4096)));
}

/**
 * Extract the session id plus assistant/tool/summary usage from a JSONL buffer.
 * Returns partial results when aborted — callers must check `signal.aborted`
 * before caching or using the result.
 */
async function parseSessionBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
	const messages: SessionMessage[] = [];
	// Tool usage follows the file's other records, the order earlier cache versions summed in.
	const toolMessages: SessionMessage[] = [];
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
			if (signal?.aborted) return { sessionId, cwd, messages: messages.concat(toolMessages) };
		}

		const lineBuffer = buffer.subarray(start, end);
		if (end > start && lineMightBeRelevant(lineBuffer)) {
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
					const usage = parseUsageAmount(msg.usage);
					if (usage) toolMessages.push(auxiliaryMessage(usage, parsedTimestamp(msg.timestamp, entry.timestamp), typeof entry.id === "string" ? entry.id : ""));
				}
			} catch {
				// Skip malformed lines
			}
		}

		start = end + 1;
	}

	return { sessionId, cwd, messages: messages.concat(toolMessages) };
}

// =============================================================================
// On-disk cache
// =============================================================================

// Version 8: tool usage is stored as ordinary auxiliary messages and the
// always-zero slot of upstream's version 6 layout is gone.
const CACHE_VERSION = 8;

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
	auxiliary: 0 | 1,
	sourceIdIdx: number,
];

interface CacheFileEntry {
	size: number;
	mtimeMs: number;
	sessionId: string;
	cwd: string;
	messages: CachedMessageTuple[];
}

interface CachedFileState {
	size: number;
	mtimeMs: number;
	parsed: ParsedSessionFile;
}

/** The cache is only ever written by saveUsageCache, so a version and shape check is enough. */
async function loadUsageCache(cachePath: string): Promise<Map<string, CachedFileState>> {
	const result = new Map<string, CachedFileState>();
	try {
		const raw = JSON.parse(await readFile(cachePath, "utf8"));
		if (raw.version !== CACHE_VERSION) return result;
		const names: string[] = raw.names;
		for (const [filePath, entry] of Object.entries(raw.files as Record<string, CacheFileEntry>)) {
			if (!entry.messages.every((t) => t.length === 12)) continue;
			const messages = entry.messages.map((t): SessionMessage => ({
				provider: names[t[0]]!,
				model: names[t[1]]!,
				thinkingLevel: names[t[8]]!,
				source: t[10] === 1 ? "auxiliary" : "assistant",
				sourceId: names[t[11]]!,
				cost: t[2],
				input: t[3],
				output: t[4],
				cacheRead: t[5],
				cacheWrite: t[6],
				timestamp: t[7],
				reasoning: t[9],
			}));
			result.set(filePath, { size: entry.size, mtimeMs: entry.mtimeMs, parsed: { sessionId: entry.sessionId, cwd: entry.cwd, messages } });
		}
	} catch {
		return new Map(); // Missing or corrupt cache: rebuild from scratch.
	}
	return result;
}

async function saveUsageCache(cachePath: string, states: Map<string, CachedFileState>): Promise<void> {
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
				m.source === "auxiliary" ? 1 : 0,
				intern(m.sourceId),
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
// Collection orchestration
// =============================================================================

const STAT_CONCURRENCY = 16;
const DEFAULT_PARSE_CONCURRENCY = 4;
const AGGREGATE_YIELD_EVERY_FILES = 200;

interface CollectUsageOptions {
	signal?: AbortSignal;
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
						continue; // File vanished — skip it.
					}
					const parsed = await parseSessionBuffer(buffer, signal);
					if (signal?.aborted) return; // Never cache a partial parse.
					current.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, parsed });
				}
			})
		);
	}

	if (signal?.aborted) return null;

	// 5. Persist the refreshed cache (also evicts entries for deleted files).
	if (cachePath && dirty) {
		await saveUsageCache(cachePath, current).catch(() => {
			// Cache write failures must never break /usage.
		});
	}

	// 6. Aggregate in sorted path order with cross-file dedupe.
	const data = emptyUsageData({ todayMs, weekStartMs, lastWeekStartMs, last30DaysStartMs, nowMs: now.getTime() });
	const seenHashes = new Set<string>();
	let processedFiles = 0;

	for (const filePath of filePaths) {
		const state = current.get(filePath);
		if (!state || !state.parsed.sessionId) continue;

		if (++processedFiles % AGGREGATE_YIELD_EVERY_FILES === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			if (signal?.aborted) return null;
		}

		// Deduplicate history copied across branched session files.
		const deduped: SessionMessage[] = [];
		for (const m of state.parsed.messages) {
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
