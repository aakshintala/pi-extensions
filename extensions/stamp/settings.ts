import { type Section, type Setting } from "../../shared/settings/index.ts";
import { isLocale, isTimeZone, type StampSettings } from "./format.ts";

export const SETTINGS: Setting[] = [
  { key: "hourCycle", type: "enum", values: ["12h", "24h"], default: "12h", description: "Clock format" },
  { key: "locale", type: "enum", values: ["invariant", "system"], default: "invariant", other: { label: "a BCP 47 tag", test: isLocale }, description: "Time format locale" },
  { key: "timeZone", type: "enum", values: ["local"], default: "local", other: { label: "an IANA zone", test: isTimeZone }, description: "Time zone" },
];
export function frozenSettings(section: Section): { get(): Readonly<StampSettings>; stop(): void } {
  const snapshot = () => Object.freeze(section.values()) as unknown as Readonly<StampSettings>;
  let current = snapshot();
  const stop = section.onChange(() => (current = snapshot()));
  return { get: () => current, stop };
}
