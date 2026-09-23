// A job's log file for the viewer (spec #29): read in increments, SGR colours
// kept, every other control sequence stripped.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// The sequences of shared/text's oneLine: CSI, then OSC/DCS/SOS/PM/APC strings, then any other escape pair.
// ponytail: copied because shared/text does not export it; export it there if a third copy appears.
const SEQUENCE =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[\s\S]?/g;
const SGR = /^\x1b\[[0-9;:]*m$/;

/** Most lines kept; older lines are dropped. */
export const MAX_LINES = 2000;
/** Most bytes read when a log is first opened: its tail. */
const FIRST_READ = 1 << 20;

/** One log line for the screen: SGR kept, other sequences removed, tabs expanded, other control characters dropped. After a carriage return only the last write shows. */
export function logLine(s: string) {
  const parts = s.split("\r");
  const last = parts.findLast((p) => p !== "") ?? "";
  return last
    .replace(SEQUENCE, (m) => (SGR.test(m) ? m : ""))
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
}

/** Reads a log file from where the last read stopped. A missing file reads as empty; a truncated one starts over. */
export function logSource(path: string) {
  let offset = -1; // not read yet
  let decoder = new StringDecoder("utf8");
  let partial = ""; // text after the last newline
  let lines: string[] = [];
  return {
    /** Complete lines, then the unfinished last line if any. */
    lines: () => (partial ? [...lines, logLine(partial)] : lines),
    /** Reads what was appended. Returns whether anything changed. */
    read(): boolean {
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        return false;
      }
      try {
        const size = fstatSync(fd).size;
        let skipFirst = false;
        if (offset < 0 || size < offset) {
          skipFirst = size > FIRST_READ; // starting mid-file: the first line is cut
          offset = Math.max(0, size - FIRST_READ);
          decoder = new StringDecoder("utf8");
          partial = "";
          lines = [];
        }
        if (size === offset) return false;
        const buffer = Buffer.alloc(size - offset);
        const n = readSync(fd, buffer, 0, buffer.length, offset);
        offset += n;
        const text = partial + decoder.write(buffer.subarray(0, n));
        const split = text.replace(/\r\n/g, "\n").split("\n");
        partial = split.pop()!;
        if (skipFirst) split.shift();
        lines.push(...split.map(logLine));
        if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
        return true;
      } finally {
        closeSync(fd);
      }
    },
  };
}
