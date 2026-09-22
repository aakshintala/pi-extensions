import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

// FFF-backed search under the standard names (issue #10, part of #1).
// Overrides pi's built-in `grep` and `find` by name: no `ffgrep`/`fffind`
// registrations exist. Pure functions over the working tree; no session
// state of any kind (module-global or otherwise).

const GREP_MAX_MATCHES = 100;
const FIND_MAX_RESULTS = 1000;
const MAX_BYTES = 50_000;
const MAX_LINE_LEN = 500;

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface FindParams {
  pattern: string;
  path?: string;
  limit?: number;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// `*`/`?` never cross `/`; `**` does. Anchored full match. A leading
// `**/` also matches zero directories (`**/*.ts` finds top-level files).
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  if (glob.startsWith("**/")) {
    out += "(.*/)?";
    i = 3;
  }
  for (; i < glob.length; ) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

interface IgnoreRule {
  neg: boolean;
  re: RegExp;
}

// .gitignore subset: `#` comments, `!` negation (last match wins),
// trailing-`/` directory rules, basename rules (no `/`) matched at any
// depth, rooted rules otherwise. `.git` is always skipped, and a skipped
// directory is never descended into (same as git: files under an excluded
// directory cannot be re-included).
function loadIgnore(root: string): IgnoreRule[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    let neg = false;
    if (line.startsWith("!")) {
      neg = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ neg, re: globToRegExp(line.includes("/") ? line : `**/${line}`) });
  }
  return rules;
}

function isIgnored(rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  const parts = rel.split(sep);
  if (parts[0] === ".git") return true;
  const norm = parts.join("/");
  let ignored = false;
  for (const r of rules) {
    if (r.re.test(norm) || (isDir && r.re.test(`${norm}/`))) ignored = !r.neg;
  }
  return ignored;
}

interface Entry {
  rel: string;
  abs: string;
  isDir: boolean;
}

// Depth-first walk of root, skipping ignored entries. Return true from
// visit to stop the walk early (caps reached, abort requested).
function walk(root: string, rules: IgnoreRule[], signal: AbortSignal | undefined, visit: (e: Entry) => boolean): void {
  const stack: Entry[] = [{ rel: "", abs: root, isDir: true }];
  while (stack.length > 0) {
    const dir = stack.pop() as Entry;
    signal?.throwIfAborted();
    let names;
    try {
      names = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let i = names.length - 1; i >= 0; i--) {
      const d = names[i];
      const rel = dir.rel ? `${dir.rel}${sep}${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (isIgnored(rel, isDir, rules)) continue;
      if (visit({ rel, abs: join(dir.abs, d.name), isDir })) return;
      if (isDir) stack.push({ rel, abs: join(dir.abs, d.name), isDir });
    }
  }
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line;
}

function runGrep(params: GrepParams, signal: AbortSignal | undefined): string {
  const root = resolve(params.path ?? process.cwd());
  if (!existsSync(root)) return `path not found: ${params.path}`;
  const single = statSync(root).isFile();
  const rules = single ? [] : loadIgnore(root);
  const fileFilter = params.glob ? globToRegExp(params.glob) : null;
  let matcher: (line: string) => boolean;
  if (params.literal) {
    matcher = (line) =>
      params.ignoreCase ? line.toLowerCase().includes(params.pattern.toLowerCase()) : line.includes(params.pattern);
  } else {
    let re: RegExp;
    try {
      re = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
    } catch {
      return `invalid regex: ${params.pattern}`;
    }
    matcher = (line) => re.test(line);
  }
  const maxMatches = Math.min(params.limit ?? GREP_MAX_MATCHES, GREP_MAX_MATCHES);
  const context = Math.max(0, params.context ?? 0);
  const out: string[] = [];
  let bytes = 0;
  let matched = 0;
  let rendered = 0;
  let capped = false;

  const searchFile = (rel: string, abs: string): boolean => {
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      return false;
    }
    if (raw.includes("\0")) return false; // binary
    const lines = raw.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) {
        hits.push(i);
        matched++;
      }
    }
    const covered = new Set<number>();
    for (const h of hits) {
      if (rendered >= maxMatches) {
        capped = true;
        return true;
      }
      for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context); i++) {
        if (covered.has(i)) continue;
        if (bytes >= MAX_BYTES) {
          capped = true;
          return true;
        }
        const text = `${rel}:${i + 1}: ${truncateLine(lines[i])}`;
        out.push(text);
        bytes += Buffer.byteLength(text, "utf8") + 1;
        covered.add(i);
      }
      rendered++;
    }
    return false;
  };

  const toPosix = (rel: string) => rel.split(sep).join("/");
  if (single) {
    searchFile(relative(process.cwd(), root) || basename(root), root);
  } else {
    walk(root, rules, signal, (e) => {
      if (e.isDir) return false;
      if (fileFilter && !fileFilter.test(toPosix(e.rel)) && !fileFilter.test(basename(e.rel))) return false;
      return searchFile(toPosix(e.rel), e.abs);
    });
  }
  if (rendered === 0) return `No matches for "${params.pattern}" in ${params.path ?? "."}`;
  if (capped) out.push(`(truncated: showing first ${rendered} of ${matched}+ matches)`);
  return out.join("\n");
}

function runFind(params: FindParams, signal: AbortSignal | undefined): string {
  const root = resolve(params.path ?? process.cwd());
  if (!existsSync(root)) return `path not found: ${params.path}`;
  if (statSync(root).isFile()) return basename(root);
  const rules = loadIgnore(root);
  const re = globToRegExp(params.pattern);
  const maxResults = Math.min(params.limit ?? FIND_MAX_RESULTS, FIND_MAX_RESULTS);
  const out: string[] = [];
  let bytes = 0;
  let capped = false;
  walk(root, rules, signal, (e) => {
    if (e.rel === "") return false;
    const norm = e.rel.split(sep).join("/");
    if (!re.test(norm) && !re.test(basename(norm))) return false;
    const text = e.isDir ? `${norm}/` : norm;
    out.push(text);
    bytes += Buffer.byteLength(text, "utf8") + 1;
    if (out.length >= maxResults || bytes >= MAX_BYTES) {
      capped = true;
      return true;
    }
    return false;
  });
  out.sort();
  if (out.length === 0) return `No files matching "${params.pattern}" in ${params.path ?? "."}`;
  if (capped) out.push(`(truncated: showing first ${out.length} results)`);
  return out.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
    parameters: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search (default: current directory)" },
        glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
        literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
        context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
        limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
      },
    },
    async execute(_toolCallId, params, signal) {
      return textResult(runGrep(params as GrepParams, signal));
    },
  });

  pi.registerTool({
    name: "find",
    label: "Find",
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
    parameters: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
        },
        path: { type: "string", description: "Directory to search in (default: current directory)" },
        limit: { type: "number", description: "Maximum number of results (default: 1000)" },
      },
    },
    async execute(_toolCallId, params, signal) {
      return textResult(runFind(params as FindParams, signal));
    },
  });
}
