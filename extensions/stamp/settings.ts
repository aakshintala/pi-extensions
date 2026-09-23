// The `stamp` section of rig.json, its frozen snapshot, and the one-time import
// from the old fork's pi-stamp.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { problem, type Section, type Setting } from "../../shared/settings/index.ts";
import { isLocale, isTimeZone, type StampSettings } from "./format.ts";

export const SETTINGS: Setting[] = [
  { key: "hourCycle", type: "enum", values: ["24h", "12h"], default: "24h", description: "Clock format" },
  { key: "showSeconds", type: "boolean", default: true, description: "Show seconds" },
  { key: "dateContext", type: "enum", values: ["day-change", "always", "never"], default: "day-change", description: "When to show the date" },
  {
    key: "locale", type: "enum", values: ["invariant", "system"], default: "invariant",
    other: { label: "a BCP 47 tag", test: isLocale }, description: "Time format locale (edit rig.json for a BCP 47 tag)",
  },
  {
    key: "timeZone", type: "enum", values: ["local"], default: "local",
    other: { label: "an IANA zone", test: isTimeZone }, description: "Time zone (edit rig.json for an IANA zone)",
  },
  { key: "responseTiming", type: "enum", values: ["off", "duration", "detailed"], default: "off", description: "Response timing after the time" },
  { key: "assistantMetadata", type: "enum", values: ["off", "compact", "expanded"], default: "off", description: "Model, tokens and cost under responses" },
  { key: "showExactTimeline", type: "boolean", default: true, description: "Exact timeline when output is expanded" },
  { key: "showThinkingLevel", type: "boolean", default: true, description: "Thinking level in metadata" },
  { key: "showCompactAbnormalOutcome", type: "boolean", default: true, description: "Abnormal stop reasons in compact metadata" },
  { key: "showCostSinceUser", type: "boolean", default: false, description: "Cost since your last message" },
  { key: "toolStamps", type: "boolean", default: false, description: "Duration and outcome of each tool" },
];

/** The section's values as one frozen object, replaced only when a setting changes. */
export function frozenSettings(section: Section): () => Readonly<StampSettings> {
  const snapshot = () => Object.freeze(section.values()) as unknown as Readonly<StampSettings>;
  let current = snapshot();
  section.onChange(() => (current = snapshot()));
  return () => current;
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Carries valid values from `<agentDir>/pi-stamp.json` into the section when rig.json
 * has no `stamp` section yet. Never writes pi-stamp.json.
 */
// ponytail: "no stamp section" is the only marker, so resetting every stamp setting
// in /rig re-imports on the next start while pi-stamp.json exists.
export function importPiStamp(section: Section, rigPath: string, agentDir: string): void {
  const rig = readJson(rigPath);
  if (isObject(rig) && Object.hasOwn(rig, section.name)) return;
  const old = readJson(join(agentDir, "pi-stamp.json"));
  if (!isObject(old)) return;
  for (const setting of section.settings) {
    const value = old[setting.key];
    if (Object.hasOwn(old, setting.key) && !problem(setting, value) && value !== setting.default) {
      section.set(setting.key, value as string | boolean);
    }
  }
}
