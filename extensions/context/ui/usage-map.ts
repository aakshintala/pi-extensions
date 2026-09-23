/**
 * Pure proportional-cell model for the Usage view's context map. Geometry is
 * an input: the caller clamps the default cell counts to what the viewport
 * can render. The map uses estimated category totals against the context
 * window. Pi's separately reported occupied tokens may differ
 * because of tokenizer, serialization, caching, and last-response timing.
 */
import type { ContextUsageSnapshot } from "../model.ts";

/** One visual map cell assigned to a category, the auto-compact buffer, or remaining free space. */
export interface UsageMapCell {
	readonly categoryId?: string;
	readonly fill: "full" | "partial" | "buffer" | "free";
}

/** Rectangular context-usage map in row-major order. */
export interface UsageMap {
	readonly columns: number;
	readonly rows: number;
	/** Tokens one cell represents. */
	readonly blockTokens: number;
	readonly cells: readonly UsageMapCell[];
}

interface MapSegment {
	readonly categoryId: string;
	readonly start: number;
	readonly end: number;
}

/**
 * Build a proportional map from estimated categories against the context
 * window. Returns undefined without a usable context window.
 */
export function buildUsageMap(
	usage: ContextUsageSnapshot,
	columns: number,
	rows: number,
): UsageMap | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (
		contextWindow === undefined ||
		!Number.isFinite(contextWindow) ||
		contextWindow <= 0 ||
		columns <= 0 ||
		rows <= 0
	) return undefined;

	const cellCount = Math.floor(columns) * Math.floor(rows);
	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const occupiedTokens = clamp(estimatedTotal, 0, contextWindow);
	const occupiedCells = occupiedTokens / contextWindow * cellCount;
	const bufferTokens = clamp(usage.autoCompactReserveTokens ?? 0, 0, contextWindow - occupiedTokens);
	const bufferStart = (contextWindow - bufferTokens) / contextWindow * cellCount;
	const segments = createSegments(usage, estimatedTotal, occupiedCells);
	const cells = Array.from(
		{ length: cellCount },
		(_, index) => createCell(index, occupiedCells, bufferStart, segments),
	);
	return {
		columns: Math.floor(columns),
		rows: Math.floor(rows),
		blockTokens: contextWindow / cellCount,
		cells,
	};
}

/** Scale estimated category shares into the occupied map range. */
function createSegments(
	usage: ContextUsageSnapshot,
	estimatedTotal: number,
	occupiedCells: number,
): MapSegment[] {
	if (estimatedTotal <= 0 || occupiedCells <= 0) return [];
	const segments: MapSegment[] = [];
	let cursor = 0;
	for (const category of usage.categories) {
		const size = category.tokens / estimatedTotal * occupiedCells;
		segments.push({ categoryId: category.id, start: cursor, end: cursor + size });
		cursor += size;
	}
	return segments;
}

/** Assign one map cell to its largest category overlap and classify its fill. */
function createCell(
	index: number,
	occupiedCells: number,
	bufferStart: number,
	segments: readonly MapSegment[],
): UsageMapCell {
	const occupiedOverlap = overlap(index, index + 1, 0, occupiedCells);
	if (occupiedOverlap <= 0) {
		// An unoccupied cell belongs to the buffer when at least half of it lies past the trigger point.
		return overlap(index, index + 1, bufferStart, index + 1) >= 0.5 ? { fill: "buffer" } : { fill: "free" };
	}

	let categoryId: string | undefined;
	let categoryOverlap = 0;
	for (const segment of segments) {
		const currentOverlap = overlap(index, index + 1, segment.start, segment.end);
		if (currentOverlap > categoryOverlap) {
			categoryId = segment.categoryId;
			categoryOverlap = currentOverlap;
		}
	}
	return {
		categoryId,
		fill: categoryOverlap >= 0.7 ? "full" : "partial",
	};
}

/** Length shared by two half-open numeric ranges. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
	return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Restrict a finite value to an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.min(maximum, Math.max(minimum, value));
}
