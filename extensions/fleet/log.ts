// A job's log file for the viewer (spec #29): read in increments, SGR colours
// kept, every other control sequence stripped.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { keepSgr, oneLine, unfinished } from "../../shared/text/index.ts";

/** Most lines kept; older lines are dropped. */
export const MAX_LINES = 2000;
/** Most bytes one read takes; anything appended before them is skipped. */
export const MAX_READ = 1 << 20;
/** Most characters kept of an unended line; the rest of it is dropped. */
export const PARTIAL_MAX = 16 * 1024;

/** One log line for the screen: SGR kept, other sequences removed, tabs expanded, other control characters dropped. After a carriage return only the last write shows. */
export function logLine(s: string) {
  const last = s.split("\r").findLast((p) => p !== "") ?? "";
  return keepSgr(last)
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
}

/**
 * Reads a log file from where the last read stopped. A missing file reads as empty;
 * a truncated one starts over. A read never throws: any other error shows as the last line.
 */
export function logSource(path: string) {
  let offset = 0;
  let decoder = new StringDecoder("utf8");
  let partial = ""; // text after the last newline, from its last carriage-return write
  let shown: string[] | undefined; // lines() until the next read
  let lines: string[] = [];
  let error = "";
  let skipped = 0; // bytes never read; shown above the lines, outside the MAX_LINES cap
  return {
    /** Complete lines, the unfinished last line up to any sequence cut off at its end, then a read error if any. */
    lines() {
      if (shown) return shown;
      const out = partial ? [...lines, logLine(partial.slice(0, unfinished(partial)))] : lines;
      return (shown = [...(skipped ? [`… ${skipped} bytes skipped`] : []), ...out, ...(error ? [error] : [])]);
    },
    /** Reads what was appended, at most MAX_READ bytes. Returns whether anything changed. */
    read(): boolean {
      const before = error;
      shown = undefined;
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        error = "";
        if (size < offset) [offset, partial, lines, decoder, skipped] = [0, "", [], new StringDecoder("utf8"), 0];
        if (size === offset) return error !== before;
        let cut = false; // reading from mid-file: the first line is partial
        if (size - offset > MAX_READ) {
          // The tail replaces what was shown: those lines are older than the gap.
          skipped += size - MAX_READ - offset + Buffer.byteLength(partial);
          [offset, partial, lines, decoder, cut] = [size - MAX_READ, "", [], new StringDecoder("utf8"), true];
        }
        const buffer = Buffer.alloc(size - offset);
        const n = readSync(fd, buffer, 0, buffer.length, offset);
        offset += n;
        const split = (partial + decoder.write(buffer.subarray(0, n))).replace(/\r\n/g, "\n").split("\n");
        partial = split.pop()!;
        // Only the last carriage-return write shows (logLine), so a progress bar that never ends its line stays small.
        let end = partial.length;
        while (partial[end - 1] === "\r") end--;
        partial = partial.slice(partial.lastIndexOf("\r", end - 1) + 1);
        if (partial.length > PARTIAL_MAX) {
          const head = partial.slice(0, PARTIAL_MAX);
          partial = head.slice(0, unfinished(head)); // never ends in a cut sequence
        }
        if (cut) split.shift();
        lines.push(...split.slice(-MAX_LINES).map(logLine)); // a spread of every line in 1 MiB can overflow the stack
        if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // not written yet
        error = `cannot read the log: ${oneLine((e as Error).message)}`;
        return error !== before;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
