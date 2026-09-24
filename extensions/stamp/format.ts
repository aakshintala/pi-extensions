export interface StampSettings {
  hourCycle: "24h" | "12h";
  locale: string;
  timeZone: string;
}

export function isLocale(value: string): boolean {
  try { return /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(value) && Intl.getCanonicalLocales(value).length === 1; }
  catch { return false; }
}
export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
}

// One formatter per (locale, time zone, style): constructing them also builds native
// ICU objects, so repeated labels reuse the same instances instead of churning them.
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (locale: string | undefined, timeZone: string | undefined, hourCycle: "24h" | "12h", kind: "time" | "date") => {
  const key = `${locale ?? ""}|${timeZone ?? ""}|${hourCycle}|${kind}`;
  let f = formatters.get(key);
  if (!f) {
    f =
      kind === "time"
        ? new Intl.DateTimeFormat(locale, {
            timeZone,
            hour: "numeric",
            minute: "2-digit",
            hourCycle: hourCycle === "24h" ? "h23" : "h12",
          })
        : new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium" });
    formatters.set(key, f);
  }
  return f;
};
export function formatStampLabel(timestamp: number, previous: number | undefined, settings: Readonly<StampSettings>): string | undefined {
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return undefined;
  try {
    const locale = settings.locale === "invariant" ? "en-US" : settings.locale === "system" ? undefined : settings.locale;
    const timeZone = settings.timeZone === "local" ? undefined : settings.timeZone;
    const time = formatter(locale, timeZone, settings.hourCycle, "time").format(timestamp);
    const date = (value: number) => formatter(locale, timeZone, settings.hourCycle, "date").format(value);
    return previous !== undefined && date(previous) !== date(timestamp) ? `${date(timestamp)} · ${time}` : time;
  } catch { return undefined; }
}
