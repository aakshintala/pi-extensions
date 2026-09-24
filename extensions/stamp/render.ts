import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatStampLabel, type StampSettings } from "./format.ts";

export const STAMP_ENTRY_TYPE = "pi-stamp";
interface RunStamp { version: 1; startedAt: number; endedAt: number }

export function stampRenderer(settings: () => Readonly<StampSettings>): EntryRenderer {
  return (entry, _options, theme) => {
    const data = entry.data as Partial<RunStamp> | null;
    // Existing per-message stamps are intentionally ignored, not migrated.
    if (!data || data.version !== 1 || !valid(data.startedAt) || !valid(data.endedAt) || data.endedAt < data.startedAt) return undefined;
    const seconds = Math.round((data.endedAt - data.startedAt) / 1000);
    const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return {
      render(width) {
        if (width < 1) return [];
        const line = `✻ Worked for ${duration} · done ${formatStampLabel(data.endedAt, data.startedAt, settings()) ?? ""}`;
        return [truncateToWidth(theme.fg("dim", line), width)];
      },
      invalidate() {},
    } satisfies Component;
  };
}
function valid(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()); }
