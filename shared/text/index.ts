// Plain-text helpers for strings from models or producers that end up on screen.

// CSI (7- and 8-bit); OSC, DCS, SOS, PM and APC strings (7- and 8-bit), ended by
// BEL, ST (ESC \\ or 0x9c) or the end of the text; then any other escape pair.
const SEQUENCE =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[\s\S]?/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
// The same sequences, complete: a string needs its terminator, an escape its next character.
const COMPLETE = /^(?:(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x9c)|\x1b[^[\]PX^_])/;

/** One line of plain text: terminal sequences removed, control characters and newlines collapsed to a space. */
export const oneLine = (s: unknown) =>
  String(s ?? "")
    .replace(SEQUENCE, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

/** Terminal sequences removed. Control characters and line breaks are left alone. */
export const stripSequences = (s: string) => s.replace(SEQUENCE, "");

/** Terminal sequences removed except SGR (colours and styles). Control characters are left alone. */
export const keepSgr = (s: string) => s.replace(SEQUENCE, (m) => (SGR.test(m) ? m : ""));

/** Where a sequence cut off by the end of `s` starts, or `s.length` when nothing is cut off. For text that arrives in pieces. */
export function unfinished(s: string) {
  const i = Math.max(...[..."\x1b\x90\x98\x9b\x9d\x9e\x9f"].map((c) => s.lastIndexOf(c)));
  return i < 0 || COMPLETE.test(s.slice(i)) ? s.length : i;
}

const COUNT_UNITS: [size: number, unit: string][] = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
];

/**
 * Compact count for a token/message tally: 999, 1.2k, 43k, 3.4M. The unit is
 * chosen after rounding, not before, so a value that would round up to the
 * next unit (9,999 → "10k", 999,999 → "1.0M") reports that unit instead of
 * printing a trailing-zero decimal like "10.0k" or "1000.0k".
 *
 * `decimals: "always"` keeps one decimal at every magnitude (16.4k, 110.6k),
 * only dropping it when it's exactly zero — for a legend column that needs
 * finer distinctions between nearby sizes. Default "auto" drops the decimal
 * once the value is no longer a single digit (16k, 111k).
 */
export function formatCount(n: number, opts: { zero?: string; decimals?: "auto" | "always" } = {}): string {
  if (n === 0) return opts.zero ?? "0";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const [size, unit] = COUNT_UNITS.find(([s]) => abs >= s * 0.9995) ?? COUNT_UNITS[COUNT_UNITS.length - 1]!;
  const value = n / size;
  if (opts.decimals === "always") {
    const fixed = value.toFixed(1);
    return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}${unit}`;
  }
  return `${Math.abs(value) < 9.95 ? value.toFixed(1) : Math.round(value)}${unit}`;
}
