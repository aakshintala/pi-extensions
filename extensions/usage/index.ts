/**
 * /usage: usage across all sessions, as a graph explorer and a provider
 * table, per period. Ported from @tmustier/pi-usage-extension 0.9.5 (MIT,
 * see README); data collection lives in ./data.ts, the chart in ./graph.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { oneLine } from "../../shared/text/index.ts";

import { collectUsageData, resolveSessionsDir, TAB_ORDER, usageCachePath } from "./data.ts";
import type { BaseStats, CollectProgress, TabName, UsageData } from "./data.ts";
import { buildGraphModel, GROUP_LABELS, GROUP_ORDER, METRIC_LABELS, METRIC_ORDER, renderChart, TOTAL_SERIES_KEY } from "./graph.ts";
import type { GraphGroupBy, GraphMetric, GraphModel } from "./graph.ts";

type ViewMode = "graph" | "table";

const VIEW_CYCLE: ViewMode[] = ["graph", "table"];

const VIEW_LABELS: Record<ViewMode, string> = { graph: "Graphs", table: "Table" };

// =============================================================================
// Column Configuration
// =============================================================================

interface DataColumn {
	label: string;
	width: number;
	dimmed?: boolean;
	getValue: (stats: BaseStats & { sessions: Set<string> | number }) => string;
}

interface TableLayoutCandidate {
	columns: DataColumn[];
	minNameWidth: number;
	compact?: boolean;
}

interface TableLayout {
	columns: DataColumn[];
	nameWidth: number;
	tableWidth: number;
	compact: boolean;
}

const MAX_NAME_COL_WIDTH = 26;

const SESSIONS_COLUMN: DataColumn = {
	label: "Sessions",
	width: 9,
	getValue: (s) => formatNumber(typeof s.sessions === "number" ? s.sessions : s.sessions.size),
};
const MSGS_COLUMN: DataColumn = { label: "Msgs", width: 9, getValue: (s) => formatNumber(s.messages) };
const COST_COLUMN: DataColumn = { label: "Cost", width: 9, getValue: (s) => formatCost(s.cost) };
const TOKENS_COLUMN: DataColumn = { label: "Tokens", width: 9, getValue: (s) => formatTokens(s.tokens.total) };
const INPUT_COLUMN: DataColumn = {
	label: "↑In",
	width: 8,
	dimmed: true,
	// Include cacheWrite so this reflects fresh input tokens sent this turn,
	// even for providers like Anthropic that split cached prompt creation out.
	getValue: (s) => formatTokens(s.tokens.input + s.tokens.cacheWrite),
};
const OUTPUT_COLUMN: DataColumn = { label: "↓Out", width: 8, dimmed: true, getValue: (s) => formatTokens(s.tokens.output) };
const CACHE_COLUMN: DataColumn = {
	label: "Cache",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.cacheRead + s.tokens.cacheWrite),
};

const TABLE_LAYOUTS: TableLayoutCandidate[] = [
	{ columns: [SESSIONS_COLUMN, MSGS_COLUMN, COST_COLUMN, TOKENS_COLUMN, INPUT_COLUMN, OUTPUT_COLUMN, CACHE_COLUMN], minNameWidth: MAX_NAME_COL_WIDTH },
	{ columns: [SESSIONS_COLUMN, MSGS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 14, compact: true },
	{ columns: [SESSIONS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 12, compact: true },
	{ columns: [COST_COLUMN, TOKENS_COLUMN], minNameWidth: 10, compact: true },
	{ columns: [COST_COLUMN], minNameWidth: 8, compact: true },
];

// =============================================================================
// Formatting Helpers
// =============================================================================

function formatCost(cost: number): string {
	if (cost === 0) return "-";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	if (cost < 100) return `$${cost.toFixed(1)}`;
	return `$${Math.round(cost)}`;
}

function formatTokens(count: number): string {
	if (count === 0) return "-";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatNumber(n: number): string {
	if (n === 0) return "-";
	return n.toLocaleString();
}

// Compact axis/legend formatters for the graph view.
function formatAxisCost(v: number): string {
	if (v === 0) return "$0";
	if (v < 1) return `$${v.toFixed(2)}`;
	if (v < 100) return `$${v.toFixed(1)}`;
	if (v < 10_000) return `$${Math.round(v)}`;
	if (v < 1_000_000) return `$${(v / 1000).toFixed(1)}k`;
	return `$${(v / 1_000_000).toFixed(2)}M`;
}

function formatAxisCount(v: number): string {
	if (v === 0) return "0";
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	return `${(v / 1_000_000_000).toFixed(1)}B`;
}

// Graph series colours come from the theme (Total uses index 0).
const SERIES_COLORS: ThemeColor[] = ["text", "accent", "success", "warning", "mdLink", "mdCode", "error", "muted"];

function seriesColor(index: number): ThemeColor {
	return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

/** "14:32" if the timestamp is today, otherwise "16 Jul" (with year if not this year). */
function formatSinceDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
	if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

function padLeft(s: string, len: number): string {
	const vis = visibleWidth(s);
	return vis >= len ? s : " ".repeat(len - vis) + s;
}

function padRight(s: string, len: number): string {
	const vis = visibleWidth(s);
	return vis >= len ? s : s + " ".repeat(len - vis);
}

function fitCell(s: string, len: number, align: "left" | "right" = "left"): string {
	if (len <= 0) return "";
	const truncated = truncateToWidth(s, len);
	return align === "right" ? padLeft(truncated, len) : padRight(truncated, len);
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFittingText(width: number, variants: string[]): string {
	for (const variant of variants) {
		if (visibleWidth(variant) <= width) return variant;
	}
	return variants[variants.length - 1] || "";
}

function getTableLayout(width: number): TableLayout {
	const safeWidth = Math.max(width, 0);
	const fit = (candidate: TableLayoutCandidate): TableLayout => {
		const columnsWidth = candidate.columns.reduce((sum, col) => sum + col.width, 0);
		const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - columnsWidth, 0));
		return { columns: candidate.columns, nameWidth, tableWidth: nameWidth + columnsWidth, compact: candidate.compact ?? false };
	};
	for (const candidate of TABLE_LAYOUTS) {
		const layout = fit(candidate);
		if (layout.nameWidth >= candidate.minNameWidth) return layout;
	}
	return fit(TABLE_LAYOUTS[TABLE_LAYOUTS.length - 1]!);
}

// =============================================================================
// Component
// =============================================================================

const TAB_LABELS: Record<TabName, string> = {
	today: "Today",
	thisWeek: "This Week",
	lastWeek: "Last Week",
	last30Days: "Last 30 Days",
	allTime: "All Time",
};

/** Lines around the table body: border, title, tabs, header, totals, help, bottom border. */
const TABLE_CHROME_ROWS = 16;

/** Exported for render tests; `/usage` creates it after collecting. */
export class UsageComponent {
	private activeTab: TabName = "allTime";
	private viewMode: ViewMode = "graph";
	private selectedIndex = 0;
	private scrollTop = 0;
	private expanded = new Set<string>();
	private providerOrder: string[] = [];

	private graphMetric: GraphMetric = "cost";
	private graphGroupBy: GraphGroupBy = "provider";
	private graphCumulative = true;
	private graphHidden = new Set<string>();
	private graphLegendIndex = 0;

	// Rendering is cached until the view state or the terminal size changes.
	private graphModel: GraphModel | null = null;
	private rendered: { width: number; rows: number; lines: string[] } | null = null;

	private readonly theme: Theme;
	private readonly data: UsageData;
	private readonly terminalRows: () => number;
	private readonly requestRender: () => void;
	private readonly done: () => void;

	constructor(theme: Theme, data: UsageData, terminalRows: () => number, requestRender: () => void, done: () => void) {
		this.theme = theme;
		this.data = data;
		this.terminalRows = terminalRows;
		this.requestRender = requestRender;
		this.done = done;
		this.updateProviderOrder();
	}

	/** Drop cached output after any state change and ask for a render. */
	private changed(graph = false): void {
		if (graph) this.graphModel = null;
		this.rendered = null;
		this.requestRender();
	}

	private updateProviderOrder(): void {
		const stats = this.data[this.activeTab];
		this.providerOrder = Array.from(stats.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.providerOrder.length - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, "v")) {
			this.viewMode = VIEW_CYCLE[(VIEW_CYCLE.indexOf(this.viewMode) + 1) % VIEW_CYCLE.length]!;
			this.changed();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			const step = matchesKey(data, "tab") || matchesKey(data, "right") ? 1 : TAB_ORDER.length - 1;
			this.activeTab = TAB_ORDER[(TAB_ORDER.indexOf(this.activeTab) + step) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.changed(true);
			return;
		}
		if (this.viewMode === "graph") this.handleGraphInput(data);
		else this.handleTableInput(data);
	}

	private handleTableInput(data: string): void {
		if (matchesKey(data, "up") && this.selectedIndex > 0) {
			this.selectedIndex--;
		} else if (matchesKey(data, "down") && this.selectedIndex < this.providerOrder.length - 1) {
			this.selectedIndex++;
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const provider = this.providerOrder[this.selectedIndex];
			if (!provider) return;
			if (!this.expanded.delete(provider)) this.expanded.add(provider);
		} else {
			return;
		}
		this.changed();
	}

	private handleGraphInput(data: string): void {
		if (matchesKey(data, "m")) {
			this.graphMetric = METRIC_ORDER[(METRIC_ORDER.indexOf(this.graphMetric) + 1) % METRIC_ORDER.length]!;
		} else if (matchesKey(data, "g")) {
			this.graphGroupBy = GROUP_ORDER[(GROUP_ORDER.indexOf(this.graphGroupBy) + 1) % GROUP_ORDER.length]!;
			this.graphHidden.clear();
			this.graphLegendIndex = 0;
		} else if (matchesKey(data, "c")) {
			this.graphCumulative = !this.graphCumulative;
		} else if (matchesKey(data, "a")) {
			this.graphHidden.clear();
		} else if (matchesKey(data, "up")) {
			this.graphLegendIndex = Math.max(0, this.graphLegendIndex - 1);
			this.changed();
			return;
		} else if (matchesKey(data, "down")) {
			const count = this.getGraphModel().series.length;
			this.graphLegendIndex = Math.min(Math.max(count - 1, 0), this.graphLegendIndex + 1);
			this.changed();
			return;
		} else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const target = this.getGraphModel().series[this.graphLegendIndex];
			if (!target) return;
			if (!this.graphHidden.delete(target.key)) this.graphHidden.add(target.key);
		} else {
			return;
		}
		this.changed(true);
	}

	private getGraphModel(): GraphModel {
		this.graphModel ??= buildGraphModel(this.data.hourly, {
			period: this.activeTab,
			metric: this.graphMetric,
			groupBy: this.graphGroupBy,
			cumulative: this.graphCumulative,
			hidden: this.graphHidden,
			bounds: this.data.bounds,
		});
		return this.graphModel;
	}

	render(width: number): string[] {
		const rows = this.terminalRows();
		if (this.rendered?.width === width && this.rendered.rows === rows) return this.rendered.lines;
		const layout = getTableLayout(width);
		const body =
			this.viewMode === "graph"
				? this.renderGraph(width)
				: [...this.renderHeader(layout), ...this.renderRows(layout), ...this.renderTotals(layout)];
		const lines = clampLines([...this.renderTitle(width), ...this.renderTabs(width, layout), ...body, this.renderHelp(width)], width);
		this.rendered = { width, rows, lines };
		return lines;
	}

	invalidate(): void {
		this.rendered = null;
	}

	private renderTitle(width: number): string[] {
		const th = this.theme;
		const title = th.fg("accent", th.bold("Usage"));
		const fullStrip = VIEW_CYCLE.map((view) =>
			view === this.viewMode ? th.fg("accent", `[${VIEW_LABELS[view]}]`) : th.fg("dim", ` ${VIEW_LABELS[view]} `),
		).join(" ");
		const activeOnly = th.fg("accent", `[${VIEW_LABELS[this.viewMode]}]`);
		const line = pickFittingText(width, [
			`${title}   ${fullStrip}  ${th.fg("dim", "[v]")}`,
			`${title}   ${activeOnly}  ${th.fg("dim", "[v]")}`,
			`${title} ${activeOnly}`,
		]);
		return [line, ""];
	}

	private renderGraph(width: number): string[] {
		const th = this.theme;
		const model = this.getGraphModel();
		const lines: string[] = [];

		lines.push(th.fg("muted", `${this.graphCumulative ? "Cumulative" : "Per bucket"} ${METRIC_LABELS[this.graphMetric]} · ${GROUP_LABELS[this.graphGroupBy]}`));
		lines.push("");

		if (model.groupedTotal === 0 && model.series.every((s) => s.total === 0)) {
			lines.push(th.fg("dim", "  No usage data for this period"));
			lines.push("");
			return lines;
		}

		const formatValue = this.graphMetric === "cost" ? formatAxisCost : formatAxisCount;
		const spanMs = model.domainEndMs - model.domainStartMs;
		const formatTime = (ms: number): string => {
			const d = new Date(ms);
			if (spanMs <= 26 * 3_600_000) {
				return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
			}
			return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
		};

		lines.push(
			...renderChart(model, {
				width: Math.max(Math.min(width, 110), 30),
				height: 12,
				formatValue,
				formatTime,
				colorize: (seriesIndex, text) => th.fg(seriesIndex < 0 ? "dim" : seriesColor(seriesIndex), text),
			}),
		);
		lines.push("");

		// Legend with selection cursor and hide/show state.
		for (let i = 0; i < model.series.length; i++) {
			const s = model.series[i]!;
			const cursor = i === this.graphLegendIndex ? th.fg("accent", "▸ ") : "  ";
			const marker = s.hidden ? th.fg("dim", "○") : th.fg(seriesColor(i), "●");
			const value = this.graphMetric === "cost" ? formatAxisCost(s.total) : formatAxisCount(s.total);
			const pct =
				s.key !== TOTAL_SERIES_KEY && model.groupedTotal > 0
					? ` ${th.fg("dim", `${Math.round((s.total / model.groupedTotal) * 100)}%`)}`
					: "";
			// Labels come from session files: strip terminal sequences before they reach the screen.
			const text = oneLine(s.label);
			const label = s.hidden ? th.fg("dim", text) : s.key === TOTAL_SERIES_KEY ? th.bold(text) : text;
			lines.push(`${cursor}${marker} ${padRight(label, 24)} ${padLeft(value, 8)}${pct}`);
		}
		lines.push("");
		return lines;
	}

	private renderTabs(width: number, layout: TableLayout): string[] {
		const th = this.theme;
		const fullTabs = TAB_ORDER.map((tab) => {
			const label = TAB_LABELS[tab];
			return tab === this.activeTab ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");
		const activeTabOnly = th.fg("accent", `[${TAB_LABELS[this.activeTab]}]`);
		const tabLine = pickFittingText(width, [fullTabs, `${activeTabOnly}  ${th.fg("dim", "[Tab/←→]")}`, activeTabOnly]);
		const infoLines =
			this.viewMode === "table" && layout.compact
				? wrapTextWithAnsi(th.fg("dim", "Compact view. Widen the terminal for more columns."), Math.max(width, 1))
				: [];
		return [tabLine, ...infoLines, ""];
	}

	private renderHeader(layout: TableLayout): string[] {
		const th = this.theme;
		let headerLine = fitCell("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const label = fitCell(col.label, col.width, "right");
			headerLine += col.dimmed ? th.fg("dim", label) : label;
		}
		return [th.fg("muted", headerLine), th.fg("border", "─".repeat(layout.tableWidth))];
	}

	private renderDataRow(
		name: string,
		stats: BaseStats & { sessions: Set<string> | number },
		layout: TableLayout,
		options: { indent?: number; selected?: boolean; dimAll?: boolean; prefix?: string } = {},
	): string {
		const th = this.theme;
		const { indent = 0, selected = false, dimAll = false, prefix } = options;
		const rawPrefix = prefix ?? " ".repeat(indent);
		const safePrefix = layout.nameWidth > 0 ? truncateToWidth(rawPrefix, layout.nameWidth, "") : "";
		const innerNameWidth = Math.max(layout.nameWidth - visibleWidth(safePrefix), 0);
		// Provider and model names come from session files: strip terminal sequences.
		const truncName = innerNameWidth > 0 ? truncateToWidth(oneLine(name), innerNameWidth) : "";
		const styledName = selected ? th.fg("accent", truncName) : dimAll ? th.fg("dim", truncName) : truncName;
		let row = safePrefix + (innerNameWidth > 0 ? padRight(styledName, innerNameWidth) : "");
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(stats), col.width, "right");
			row += col.dimmed || dimAll ? th.fg("dim", value) : value;
		}
		return row;
	}

	/** Provider rows, and model rows under expanded providers, through a viewport that follows the selection. */
	private renderRows(layout: TableLayout): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		if (this.providerOrder.length === 0) return [th.fg("dim", "  No usage data for this period")];

		const rows: string[] = [];
		let selectedRow = 0;
		this.providerOrder.forEach((providerName, i) => {
			const providerStats = stats.providers.get(providerName)!;
			const isSelected = i === this.selectedIndex;
			const isExpanded = this.expanded.has(providerName);
			const arrow = isExpanded ? "▾" : "▸";
			if (isSelected) selectedRow = rows.length;
			rows.push(
				this.renderDataRow(providerName, providerStats, layout, {
					selected: isSelected,
					prefix: isSelected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `),
				}),
			);
			if (!isExpanded) return;
			const models = Array.from(providerStats.models.entries()).sort((a, b) => b[1].cost - a[1].cost);
			for (const [modelName, modelStats] of models) {
				rows.push(this.renderDataRow(modelName, modelStats, layout, { indent: 4, dimAll: true }));
			}
		});

		const height = Math.max(3, this.terminalRows() - TABLE_CHROME_ROWS);
		if (rows.length <= height) {
			this.scrollTop = 0;
			return rows;
		}
		const visible = height - 1; // one line for the position note
		if (selectedRow < this.scrollTop) this.scrollTop = selectedRow;
		if (selectedRow >= this.scrollTop + visible) this.scrollTop = selectedRow - visible + 1;
		this.scrollTop = Math.min(this.scrollTop, rows.length - visible);
		const end = this.scrollTop + visible;
		return [...rows.slice(this.scrollTop, end), th.fg("dim", `  rows ${this.scrollTop + 1}–${end} of ${rows.length}`)];
	}

	private renderTotals(layout: TableLayout): string[] {
		const th = this.theme;
		const { totals } = this.data[this.activeTab];
		let totalRow = fitCell(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(totals), col.width, "right");
			totalRow += col.dimmed ? th.fg("dim", value) : value;
		}
		return [th.fg("border", "─".repeat(layout.tableWidth)), totalRow, ""];
	}

	private renderHelp(width: number): string {
		const variants =
			this.viewMode === "graph"
				? [
						"[Tab/←→] period  [m] metric  [g] group  [c] cumulative  [↑↓/Enter] filter  [a] all  [v] view  [q] close",
						"[Tab] period  [m] metric  [g] group  [c] cumul  [↑↓/Enter] filter  [v] view  [q] close",
						"[m] metric  [g] group  [c] cumul  [↑↓] filter  [q] close",
						"[m] [g] [c] [↑↓] [q]",
						"[q] close",
					]
				: [
						"[Tab/←→] period  [↑↓] select  [Enter] expand  [v] view  [q] close",
						"[↑↓] select  [Enter] expand  [v] view  [q] close",
						"[↑↓] select  [q] close",
						"[q] close",
					];
		return this.theme.fg("dim", pickFittingText(width, variants));
	}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Aborts a collection still running when the session shuts down.
	let stopLoading: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		stopLoading?.();
		stopLoading = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show usage statistics dashboard",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/usage needs the interactive TUI", "error");
				return;
			}
			const agentDir = getAgentDir();
			const sessionsDir = resolveSessionsDir(
				agentDir,
				ctx.sessionManager.getSessionDir(),
				SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() }).getSessionDir(),
			);

			let failure: unknown;
			let collection: Promise<void> | undefined;
			const data = await ctx.ui.custom<UsageData | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(s: string) => theme.fg("accent", s),
					(s: string) => theme.fg("muted", s),
					"Loading Usage...",
				);
				let finished = false;
				const finish = (value: UsageData | null) => {
					if (finished) return;
					finished = true;
					stopLoading = undefined;
					loader.dispose();
					done(value);
				};
				loader.onAbort = () => finish(null);
				// Shutdown aborts the collection itself, so it can never write the
				// cache after a newer collection has.
				const shutdown = new AbortController();
				stopLoading = () => {
					shutdown.abort();
					finish(null);
				};

				const onProgress = (p: CollectProgress): void => {
					if (finished || p.filesToParse === 0) return;
					const files = `${p.filesParsed.toLocaleString()}/${p.filesToParse.toLocaleString()} files`;
					if (p.mode === "update") {
						const since = p.sinceMs !== null ? ` since ${formatSinceDate(p.sinceMs)}` : "";
						loader.setMessage(`Updating your usage history${since}… (${files})`);
					} else if (p.mode === "rebuild") {
						loader.setMessage(`Rebuilding your usage history — the cache format changed… (${files})`);
					} else {
						loader.setMessage(`Building your usage history for the first time… (${files})`);
					}
				};

				const signal = AbortSignal.any([loader.signal, shutdown.signal]);
				collection = collectUsageData({ signal, onProgress, sessionsDir, cachePath: usageCachePath(agentDir) })
					.then(finish)
					.catch((error: unknown) => {
						failure = error;
						finish(null);
					});

				return loader;
			});

			// A cancelled or shut-down collection settles at its next abort check.
			await collection;
			if (failure !== undefined) {
				ctx.ui.notify(oneLine(`/usage could not read sessions in ${sessionsDir}: ${failure instanceof Error ? failure.message : String(failure)}`), "error");
				return;
			}
			if (!data) return;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const border = new DynamicBorder((s: string) => theme.fg("border", s));
				const usage = new UsageComponent(theme, data, () => tui.terminal.rows, () => tui.requestRender(), () => done());
				return {
					render: (w: number) => clampLines(["", ...border.render(w), "", ...usage.render(w), "", theme.fg("border", "─".repeat(w))], w),
					invalidate: () => {
						border.invalidate();
						usage.invalidate();
					},
					handleInput: (input: string) => usage.handleInput(input),
				};
			});
		},
	});
}
