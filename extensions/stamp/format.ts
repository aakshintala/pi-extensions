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
export function formatStampLabel(timestamp: number, previous: number | undefined, settings: Readonly<StampSettings>): string | undefined {
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return undefined;
  try {
    const locale = settings.locale === "invariant" ? "en-US" : settings.locale === "system" ? undefined : settings.locale;
    const timeZone = settings.timeZone === "local" ? undefined : settings.timeZone;
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "numeric", minute: "2-digit", hourCycle: settings.hourCycle === "24h" ? "h23" : "h12",
    }).format(timestamp);
    const date = (value: number) => new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium" }).format(value);
    return previous !== undefined && date(previous) !== date(timestamp) ? `${date(timestamp)} · ${time}` : time;
  } catch { return undefined; }
}
