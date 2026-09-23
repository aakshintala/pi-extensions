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

/** Terminal sequences removed except SGR (colours and styles). Control characters are left alone. */
export const keepSgr = (s: string) => s.replace(SEQUENCE, (m) => (SGR.test(m) ? m : ""));

/** Where a sequence cut off by the end of `s` starts, or `s.length` when nothing is cut off. For text that arrives in pieces. */
export function unfinished(s: string) {
  const i = Math.max(...[..."\x1b\x90\x98\x9b\x9d\x9e\x9f"].map((c) => s.lastIndexOf(c)));
  return i < 0 || COMPLETE.test(s.slice(i)) ? s.length : i;
}
