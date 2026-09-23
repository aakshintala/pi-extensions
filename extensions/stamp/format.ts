// Stamp labels: clock time, date context and response timing.
import { formatElapsedSeconds } from "./metadata.ts";

export interface StampSettings {
  hourCycle: "24h" | "12h";
  showSeconds: boolean;
  dateContext: "day-change" | "always" | "never";
  /** "invariant", "system" or a BCP 47 tag. */
  locale: string;
  /** "local" or an IANA zone. */
  timeZone: string;
  responseTiming: "off" | "duration" | "detailed";
  assistantMetadata: "off" | "compact" | "expanded";
  showExactTimeline: boolean;
  showThinkingLevel: boolean;
  showCompactAbnormalOutcome: boolean;
  showCostSinceUser: boolean;
  toolStamps: boolean;
}

export type TimelineBoundary = "created" | "first content" | "started" | "completed";

export interface MessageStampInput {
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  /** The first hidden tool-only response of the run this reply ends (#142). */
  runStartedAt?: number;
}

/** A well-formed BCP 47 tag with a 2–3 letter language, such as `en-US` or `de-CH-u-hc-h23`. */
export function isLocale(value: string): boolean {
  if (!/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function formatStampLabel(
  timestamp: number,
  previousTimestamp: number | undefined,
  settings: Readonly<StampSettings>,
): string | undefined {
  if (!isValidTimestamp(timestamp)) return undefined;
  try {
    const timeZone = settings.timeZone === "local" ? undefined : settings.timeZone;
    const showDate = shouldShowDate(timestamp, previousTimestamp, settings.dateContext, timeZone);
    if (settings.locale === "invariant") return formatInvariant(timestamp, showDate, settings, timeZone);
    const locale = settings.locale === "system" ? undefined : settings.locale;
    return formatLocalized(timestamp, showDate, settings, locale, timeZone);
  } catch {
    return undefined;
  }
}

export function formatMessageStampLabel(input: Readonly<MessageStampInput>, settings: Readonly<StampSettings>): string | undefined {
  const label = formatStampLabel(input.timestamp, input.previousTimestamp, settings);
  if (!label || settings.responseTiming === "off") return label;
  if (!isValidTimestamp(input.completedAt) || input.completedAt < input.timestamp) return label;
  // The total covers the whole run; time to first content is the reply's own.
  const start = isValidTimestamp(input.runStartedAt) && input.runStartedAt <= input.timestamp ? input.runStartedAt : input.timestamp;
  const total = formatElapsedSeconds(input.completedAt - start);
  if (!total) return label;
  if (settings.responseTiming === "duration") return `${label} · ${total}`;
  const first =
    isValidTimestamp(input.firstContentAt) && input.firstContentAt >= input.timestamp && input.firstContentAt <= input.completedAt
      ? formatElapsedSeconds(input.firstContentAt - input.timestamp)
      : undefined;
  return `${label} · first ${first ?? "n/a"} · total ${total}`;
}

export function formatExactTimelineLine(boundary: TimelineBoundary, timestamp: number): string | undefined {
  if (!isValidTimestamp(timestamp)) return undefined;
  return `timeline · ${boundary} ${new Date(timestamp).toISOString()} · unix-ms ${timestamp}`;
}

// ICU formatters are costly to build, so reuse them. Keys vary only with locale, zone
// and two settings, so the bound is rarely reached; past it the oldest is dropped.
export const MAX_FORMATTERS = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, create: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, (f = create()));
  }
  return f;
}

function formatInvariant(timestamp: number, showDate: boolean, settings: Readonly<StampSettings>, timeZone: string | undefined): string {
  const parts = zonedParts(timestamp, timeZone);
  const hour = settings.hourCycle === "24h" ? String(parts.hour).padStart(2, "0") : String(parts.hour % 12 || 12);
  const seconds = settings.showSeconds ? `:${parts.second}` : "";
  const period = settings.hourCycle === "12h" ? (parts.hour < 12 ? " AM" : " PM") : "";
  const time = `${hour}:${parts.minute}${seconds}${period}`;
  return showDate ? `${parts.year}-${parts.month}-${parts.day} · ${time}` : time;
}

function formatLocalized(
  timestamp: number,
  showDate: boolean,
  settings: Readonly<StampSettings>,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  const date = new Date(timestamp);
  const time = formatter(
    `time|${locale ?? ""}|${timeZone ?? ""}|${settings.showSeconds}|${settings.hourCycle}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        ...(settings.showSeconds ? { second: "2-digit" as const } : {}),
        hourCycle: settings.hourCycle === "24h" ? "h23" : "h12",
      }),
  ).format(date);
  if (!showDate) return time;
  const day = formatter(`date|${locale ?? ""}|${timeZone ?? ""}`, () =>
    new Intl.DateTimeFormat(locale, { calendar: "gregory", timeZone, dateStyle: "medium" }),
  ).format(date);
  return `${day} · ${time}`;
}

function shouldShowDate(
  timestamp: number,
  previousTimestamp: number | undefined,
  dateContext: StampSettings["dateContext"],
  timeZone: string | undefined,
): boolean {
  if (dateContext === "always") return true;
  if (dateContext === "never" || !isValidTimestamp(previousTimestamp)) return false;
  return dateKey(timestamp, timeZone) !== dateKey(previousTimestamp, timeZone);
}

function dateKey(timestamp: number, timeZone: string | undefined): string {
  const parts = zonedParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedParts(timestamp: number, timeZone: string | undefined) {
  const f = formatter(`zoned|${timeZone ?? ""}`, () =>
    new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  );
  const values = new Map(f.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  const [year, month, day, minute, second] = ["year", "month", "day", "minute", "second"].map((k) => values.get(k));
  const hour = Number(values.get("hour"));
  if (!year || !month || !day || !Number.isInteger(hour) || !minute || !second) {
    throw new Error("Intl did not return complete Gregorian date/time parts.");
  }
  return { year, month, day, hour, minute, second };
}

export function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}
