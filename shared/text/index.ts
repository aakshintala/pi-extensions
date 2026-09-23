// Plain-text helpers for strings from models or producers that end up on screen.

// CSI (7- and 8-bit); OSC, DCS, SOS, PM and APC strings (7- and 8-bit), ended by
// BEL, ST (ESC \\ or 0x9c) or the end of the text; then any other escape pair.
const SEQUENCE =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[\s\S]?/g;

/** One line of plain text: terminal sequences removed, control characters and newlines collapsed to a space. */
export const oneLine = (s: unknown) =>
  String(s ?? "")
    .replace(SEQUENCE, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
