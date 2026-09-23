// FFF-backed grep and find under the built-in names (spec #35, ticket #60).
// One FileFinder per session, scanned in the background; each search waits up to
// 5 s for the scan, else that call runs Pi's built-in tool. So does every call
// when FFF cannot load or the session cwd is $HOME or /.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createFindTool,
  createGrepTool,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FileFinder } from "@ff-labs/fff-node";

type FinderClass = Pick<typeof FileFinder, "isAvailable" | "create">;
type Finder = Pick<FileFinder, "grep" | "glob" | "fileSearch" | "waitForScan" | "destroy" | "isDestroyed">;
type Result = { content: { type: "text"; text: string }[]; details: unknown };

const SCAN_WAIT_MS = 5_000;
const GREP_LIMIT = 100;
const FIND_LIMIT = 1000;

const GREP_PARAMETERS = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: { type: "string", description: "Directory or file to search (default: current directory)" },
    glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: "boolean", description: "Case-insensitive search (default: smart case)" },
    literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
    context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
    limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
  },
};

const FIND_PARAMETERS = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Glob like '*.ts' or 'src/**/*.spec.ts', or words for a fuzzy name search" },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: "Maximum number of results (default: 1000)" },
  },
};

const text = (t: string, details?: unknown): Result => ({ content: [{ type: "text", text: t }], details });
const posix = (p: string) => p.split(sep).join("/");
// Every character outside [A-Za-z0-9_] as \x{..}: literal, and free of the spaces
// and constraint triggers (* / ! {) that FFF's query parser would consume.
const hex = (c: string) => `\\x{${c.codePointAt(0)!.toString(16)}}`;
const escapeAll = (s: string) => [...s].map((c) => (/\w/.test(c) ? c : hex(c))).join("");
const encodeSpaces = (s: string) => s.replace(/\\?\s/g, (m) => hex(m.at(-1)!));

// Appends a truncation notice the way Pi's built-in tools do.
function finish(lines: string[], notices: string[], details: Record<string, unknown>): Result {
  const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  const out = truncation.content + (notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "");
  return text(out, Object.keys(details).length > 0 ? details : undefined);
}

export function searchExtension(loadFinder: () => Promise<FinderClass> = async () => (await import("@ff-labs/fff-node")).FileFinder) {
  return (pi: ExtensionAPI) => {
    let finder: Promise<Finder | null> = Promise.resolve(null);
    let root = "";
    let noticed = false;

    async function open(cwd: string): Promise<Finder | null> {
      if (cwd === resolve(homedir()) || dirname(cwd) === cwd) return null;
      const FFF = await loadFinder();
      if (!FFF.isAvailable()) return null;
      const opts = { basePath: cwd, frecencyDbPath: join(getAgentDir(), "fff", "frecency") };
      let made = FFF.create(opts);
      // A locked or corrupt frecency db should cost ranking, not search.
      if (!made.ok) made = FFF.create({ basePath: cwd });
      return made.ok ? made.value : null;
    }

    function close() {
      const f = finder;
      finder = Promise.resolve(null);
      void f.then((x) => x && !x.isDestroyed && x.destroy());
    }

    async function ready(): Promise<Finder | null> {
      const f = await finder;
      if (!f || f.isDestroyed) return null;
      const scanned = await f.waitForScan(SCAN_WAIT_MS);
      return scanned.ok && scanned.value ? f : null;
    }

    // Absolute and index-relative forms of a tool's path argument; null when outside the index.
    function scope(ctx: ExtensionContext, path: string | undefined) {
      let abs = resolve(ctx.cwd, path || ".");
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
        abs = realpathSync(abs);
      } catch {
        throw new Error(`Path not found: ${abs}`);
      }
      const rel = posix(relative(root, abs));
      if (rel.startsWith("..") || isAbsolute(rel) || /\s/.test(rel)) return null;
      return { abs, rel, isDir };
    }

    function fallback(tool: typeof createGrepTool, ctx: ExtensionContext, args: Parameters<ReturnType<typeof createGrepTool>["execute"]>) {
      if (!noticed) {
        noticed = true;
        ctx.ui.notify("grep and find: FFF unavailable, using Pi's built-in tools", "warning");
      }
      return tool(ctx.cwd).execute(...args) as Promise<Result>;
    }

    pi.on("session_start", (_event, ctx) => {
      close();
      noticed = false;
      root = realpathSync(ctx.cwd);
      finder = open(root).catch(() => null);
    });
    pi.on("session_shutdown", close);

    pi.registerTool({
      name: "grep",
      label: "grep",
      description:
        "Search file contents. Returns path:line: text per match, respecting .gitignore.",
      parameters: GREP_PARAMETERS as never,
      async execute(id, params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }, signal, onUpdate, ctx) {
        const f = await ready();
        const where = f && scope(ctx, params.path);
        const glob = params.glob?.replace(/^!/, "");
        const unsafe = /\s/.test(glob ?? "") || (where && !where.isDir && (/[*?[\]{},]/.test(where.rel) || !/[a-z]/i.test(where.rel)));
        if (!f || !where || unsafe) return fallback(createGrepTool, ctx, [id, params, signal, onUpdate]);

        // FFF reads leading query tokens as file constraints (globs, path/ segments).
        const constraints: string[] = [];
        const base = where.rel ? `${where.rel}/` : "";
        if (!where.isDir) constraints.push(`{${where.rel},${where.rel}}`);
        else if (glob) {
          const g = glob.includes("/") ? glob.replace(/^\//, "") : `**/${glob}`;
          constraints.push(`${params.glob!.startsWith("!") ? "!" : ""}${base}${g}`);
          if (base && params.glob!.startsWith("!")) constraints.push(`${base}**`);
        } else if (base) constraints.push(`${base}**`);

        const source = params.literal ? escapeAll(params.pattern) : encodeSpaces(params.pattern);
        // A leading \-escape keeps the regex token from being read as a constraint.
        const regex = `\\x00{0}(?:${params.ignoreCase ? "(?i)" : ""}${source})`;
        const limit = Math.max(1, params.limit ?? GREP_LIMIT);
        const context = Math.max(0, params.context ?? 0);
        const r = f.grep([...constraints, regex].join(" "), {
          mode: "regex",
          smartCase: params.ignoreCase !== false,
          pageSize: limit,
          maxMatchesPerFile: limit,
          beforeContext: context,
          afterContext: context,
        });
        if (!r.ok) throw new Error(r.error);
        if (r.value.regexFallbackError) throw new Error(r.value.regexFallbackError);
        const matches = r.value.items.slice(0, limit);
        if (matches.length === 0) return text("No matches found");

        const show = (p: string) => (where.isDir ? posix(relative(where.abs, join(root, p))) : basename(p));
        const lines: string[] = [];
        let cut = false;
        const add = (p: string, n: number, sepr: string, line: string) => {
          const t = truncateLine(line.replace(/\r/g, ""));
          cut ||= t.wasTruncated;
          lines.push(`${p}${sepr}${n}${sepr} ${t.text}`);
        };
        for (const m of matches) {
          const p = show(m.relativePath);
          const before = m.contextBefore ?? [];
          before.forEach((l, i) => add(p, m.lineNumber - before.length + i, "-", l));
          add(p, m.lineNumber, ":", m.lineContent);
          (m.contextAfter ?? []).forEach((l, i) => add(p, m.lineNumber + 1 + i, "-", l));
        }
        const notices: string[] = [];
        const details: Record<string, unknown> = {};
        if (matches.length >= limit) {
          notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
          details.matchLimitReached = limit;
        }
        if (cut) {
          notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
          details.linesTruncated = true;
        }
        return finish(lines, notices, details);
      },
    });

    pi.registerTool({
      name: "find",
      label: "find",
      description:
        "Find files by name. A pattern with * ? [ or { is a glob; other text is a fuzzy name search. Git-changed and often-used files rank first. Respects .gitignore.",
      parameters: FIND_PARAMETERS as never,
      async execute(id, params: { pattern: string; path?: string; limit?: number }, signal, onUpdate, ctx) {
        const f = await ready();
        const where = f && scope(ctx, params.path);
        const { pattern } = params;
        if (!f || !where || !where.isDir || pattern.startsWith("/")) return fallback(createFindTool as never, ctx, [id, params as never, signal, onUpdate]);

        const limit = Math.max(1, params.limit ?? FIND_LIMIT);
        const base = where.rel ? `${where.rel}/` : "";
        let items;
        let total;
        if (/[*?[{]/.test(pattern)) {
          // Like Pi's fd call: the glob may match at any depth under path.
          const g = pattern === "**" || pattern.startsWith("**/") ? pattern : `**/${pattern}`;
          const r = f.glob(`${base}${g}`, { pageSize: limit });
          if (!r.ok) throw new Error(r.error);
          const dirty = (s: string) => (s === "clean" ? 0 : 1);
          items = [...r.value.items].sort((a, b) => dirty(b.gitStatus) - dirty(a.gitStatus) || b.totalFrecencyScore - a.totalFrecencyScore);
          total = r.value.totalMatched;
        } else {
          const r = f.fileSearch(pattern, { pageSize: base ? Math.max(limit, 1000) : limit });
          if (!r.ok) throw new Error(r.error);
          // ponytail: typo-tolerant matching pads results with weak hits; keep those scoring at
          // least half the best. path filters one ranked page; make it an FFF constraint if hits go missing.
          const best = r.value.scores[0]?.total ?? 0;
          const all = r.value.items.filter((i, k) => i.relativePath.startsWith(base) && (r.value.scores[k]?.total ?? 0) * 2 >= best);
          items = all.slice(0, limit);
          total = all.length;
        }
        if (items.length === 0) return text("No files found matching pattern");

        const notices: string[] = [];
        const details: Record<string, unknown> = {};
        if (total > items.length || items.length >= limit) {
          notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
          details.resultLimitReached = limit;
        }
        return finish(items.map((i) => posix(relative(where.abs, join(root, i.relativePath)))), notices, details);
      },
    });
  };
}

export default searchExtension();
