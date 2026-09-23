// The `stamp` section of rig.json, its frozen snapshot, and the one-time import
// from the old fork's pi-stamp.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { problem, type Section, type Setting } from "../../shared/settings/index.ts";
import { isLocale, isTimeZone, type StampSettings } from "./format.ts";

export const SETTINGS: Setting[] = [
  { key: "hourCycle", type: "enum", values: ["24h", "12h"], default: "24h", description: "Clock format" },
  { key: "showSeconds", type: "boolean", default: true, description: "Show seconds" },
  { key: "dateContext", type: "enum", values: ["day-change", "always", "never"], default: "day-change", description: "When to show the date" },
  {
    key: "locale", type: "enum", values: ["invariant", "system"], default: "invariant",
    other: { label: "a BCP 47 tag", test: isLocale }, description: "Time format locale",
  },
  {
    key: "timeZone", type: "enum", values: ["local"], default: "local",
    other: { label: "an IANA zone", test: isTimeZone }, description: "Time zone",
  },
  { key: "responseTiming", type: "enum", values: ["off", "duration", "detailed"], default: "off", description: "Response timing after the time" },
  { key: "assistantMetadata", type: "enum", values: ["off", "compact", "expanded"], default: "off", description: "Model, tokens and cost under responses" },
  { key: "showExactTimeline", type: "boolean", default: true, description: "Exact timeline when output is expanded" },
  { key: "showThinkingLevel", type: "boolean", default: true, description: "Thinking level in metadata" },
  { key: "showCompactAbnormalOutcome", type: "boolean", default: true, description: "Abnormal stop reasons in compact metadata" },
  { key: "showCostSinceUser", type: "boolean", default: false, description: "Cost since your last message" },
  { key: "toolStamps", type: "boolean", default: false, description: "Duration and outcome of each tool" },
];

/** The section's values as one frozen object, replaced only when a setting changes, until `stop()`. */
export function frozenSettings(section: Section): { get(): Readonly<StampSettings>; stop(): void } {
  const snapshot = () => Object.freeze(section.values()) as unknown as Readonly<StampSettings>;
  let current = snapshot();
  const stop = section.onChange(() => (current = snapshot()));
  return { get: () => current, stop };
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** POSIX locale names such as `en_US.UTF-8` become BCP 47 tags (`en-US`). */
export const bcp47 = (value: string) => value.replace(/[.@].*$/, "").replaceAll("_", "-");

/** Marker beside rig.json: once it exists, pi-stamp.json is never read again. */
export const IMPORTED = "rig-stamp-imported";

/**
 * Carries valid values from `<agentDir>/pi-stamp.json` into the section once, in one
 * write, unless rig.json already has a `stamp` section. Never writes pi-stamp.json.
 */
export function importPiStamp(section: Section, rigPath: string, agentDir: string): void {
  const marker = join(agentDir, IMPORTED);
  if (existsSync(marker)) return;
  const old = readJson(join(agentDir, "pi-stamp.json"));
  if (old === undefined) return; // missing or unreadable: nothing to import yet
  const rig = readJson(rigPath);
  if (isObject(old) && !(isObject(rig) && Object.hasOwn(rig, section.name))) {
    const changes: Record<string, string | boolean> = {};
    for (const setting of section.settings) {
      if (!Object.hasOwn(old, setting.key)) continue;
      let value = old[setting.key];
      if (setting.key === "locale" && typeof value === "string") value = bcp47(value);
      if (!problem(setting, value) && value !== setting.default) changes[setting.key] = value as string | boolean;
    }
    if (Object.keys(changes).length) section.setMany(changes);
  }
  writeFileSync(marker, "pi-stamp.json was imported into rig.json\n");
}
