// The rig's two-line footer (spec #38, ticket #66).
//   model · thinking │ in out cache $ │ ctx bar
//   cwd branch* │ Q quotas │ TTFT · TPS
// Usage and context update from events, never per draw. Git dirty state is
// checked asynchronously, debounced after tool calls, one git at a time.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { blankRepoFilters, GIT_LIMITS, runGit } from "../../shared/git/index.ts"; // no repo code runs
import { formatCount, oneLine } from "../../shared/text/index.ts"; // cwd, branch, model and provider ids come from outside
import type { Feed } from "./quota.ts";

export const GIT_DEBOUNCE_MS = 300;
const CTX_WARN = 70, CTX_DANGER = 90;
const QUOTA_WARN = 50, QUOTA_DANGER = 20;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
/** Resolves true when the work tree has changes, false when clean, null when git failed. Resolves only after git exits. */
export type GitDirty = (cwd: string, signal: AbortSignal) => Promise<boolean | null>;

export interface FooterDeps {
  timers?: Timers;
  now?: () => number;
  gitDirty?: GitDirty;
}

export { GIT_LIMITS };

export const gitDirty = async (cwd: string, signal: AbortSignal, limits = GIT_LIMITS): Promise<boolean | null> => {
  // A timed-out config leaves filters unknown: stop here, not hang again in status.
  const blank = await blankRepoFilters(cwd, signal, limits);
  if (!blank) return null;
  // Submodules count by commit only: no status runs inside them.
  const status = await runGit([...blank, "status", "--porcelain", "--ignore-submodules=dirty"], cwd, signal, { first: true, limits });
  return status.out ? true : status.ok ? false : null;
};

// One git at a time in the whole process, across sessions and reloads.
const LOCK = Symbol.for("pi-rig.status.git");
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { [LOCK]?: Promise<unknown> };
  const run = (g[LOCK] ?? Promise.resolve()).then(fn);
  g[LOCK] = run.catch(() => {});
  return run;
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
function add(t: Totals, u: Usage | undefined) {
  if (typeof u?.input !== "number") return;
  t.input += u.input;
  t.output += u.output || 0;
  t.cacheRead += u.cacheRead || 0;
  t.cacheWrite += u.cacheWrite || 0;
  t.cost += u.cost?.total || 0;
}
const billed = (m: { role?: string; usage?: Usage } | undefined) =>
  m?.role === "assistant" || m?.role === "toolResult" ? m.usage : undefined;

/** Totals over the current branch: model replies, tool results (subagents), compactions, summaries. */
function branchTotals(ctx: ExtensionContext): Totals {
  const t = zero();
  for (const e of ctx.sessionManager.getBranch() as any[]) add(t, e.type === "message" ? billed(e.message) : e.usage);
  return t;
}

export const tokens = formatCount;

export interface Snapshot {
  model?: string;
  thinking?: string;
  totals: Totals;
  contextPercent: number | null;
  cwd: string;
  branch: string | null;
  dirty: boolean | null;
  /** undefined: nothing to show yet; null: QuotaBar is unreachable. */
  feed: Feed | null | undefined;
  perf?: { ttftMs: number; tps?: number };
}

/** The footer's two lines, before truncation to the terminal width. */
export function footerLines(s: Snapshot, theme: Pick<Theme, "fg">): string[] {
  const fg = theme.fg.bind(theme);
  const dim = (x: string) => fg("dim", x);
  const sep = `  ${dim("│")}  `;

  const top: string[] = [];
  // An unknown level falls back to the "off" colour, as Pi's own thinking border does.
  const level = s.thinking && THINKING.has(s.thinking) ? s.thinking : "off";
  const head = [s.model && fg("accent", oneLine(s.model)), s.thinking && fg(`thinking${level[0].toUpperCase()}${level.slice(1)}` as never, oneLine(s.thinking))];
  if (head.some(Boolean)) top.push(head.filter(Boolean).join(" "));
  const t = s.totals, prompt = t.input + t.cacheRead + t.cacheWrite;
  top.push(
    `${dim("in")} ${tokens(t.input)} ${dim("out")} ${tokens(t.output)} ${dim("cache")} ${prompt ? `${Math.round((t.cacheRead / prompt) * 100)}%` : "--"} $${t.cost.toFixed(3)}`,
  );
  const p = s.contextPercent;
  if (p === null) top.push(dim("ctx --"));
  else {
    const filled = Math.max(0, Math.min(10, Math.round(p / 10)));
    top.push(fg(p >= CTX_DANGER ? "error" : p >= CTX_WARN ? "warning" : "accent", `ctx [${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${Math.round(p)}%`));
  }

  const cwd = oneLine(s.cwd);
  const branch = s.branch && oneLine(s.branch);
  const bottom = [branch ? `${cwd} ${fg("accent", branch)}${s.dirty ? fg("warning", "*") : ""}` : cwd];
  if (s.feed === null) bottom.push(dim("Q unavailable"));
  else if (s.feed) {
    const parts = s.feed.providers
      .filter((pr) => !pr.unavailable && pr.quotas.length)
      .map((pr) => {
        const left = pr.quotas.map((q) => q.percentRemaining);
        const min = Math.min(...left); // colour from the exact value, not the rounded text
        return fg(min < QUOTA_DANGER ? "error" : min < QUOTA_WARN ? "warning" : "text", `${oneLine(pr.id)} ${left.map((v) => `${Math.round(v)}%`).join("/")}`);
      });
    if (parts.length) bottom.push(`${dim("Q")} ${parts.join(dim(" · "))}`);
  }
  const perf = s.perf;
  const ttft = perf ? (perf.ttftMs < 1000 ? `${Math.round(perf.ttftMs)}ms` : `${(perf.ttftMs / 1000).toFixed(1)}s`) : "--";
  bottom.push(`${dim("TTFT")} ${ttft} ${dim("·")} ${dim("TPS")} ${perf?.tps !== undefined ? perf.tps.toFixed(1) : "--"}`);

  return [top.join(sep), bottom.join(sep)];
}

const tilde = (cwd: string) => {
  const home = process.env.HOME;
  return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
};

/** Registers the footer. All state lives in this instance. `quotas` sets the feed shown (undefined hides it). */
export function registerFooter(pi: ExtensionAPI, { timers = globalThis, now = Date.now, gitDirty: git = gitDirty }: FooterDeps = {}) {
  let totals = zero();
  let contextPercent: number | null = null;
  let feed: Feed | null | undefined;
  let dirty: boolean | null = null;
  let perf: Snapshot["perf"];
  let reqStart: number | undefined, firstToken: number | undefined;
  let render = () => {};
  // Bumped by every code path that can change what render() draws (including
  // branch changes, which reach it through the wrapper below), so the width-keyed
  // cache below never serves a stale line. Correctness over savings: nothing here
  // is deliberately left out of the bump.
  let version = 0;

  // Git: one debounce timer and one git per instance (one per process, via the
  // lock); a request made during a run reruns once after it.
  let cwd = "";
  let live = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | undefined; // cleared only once git has exited
  let again = false;
  function scheduleGit() {
    if (!live) return;
    timers.clearTimeout(timer);
    timer = timers.setTimeout(checkGit, GIT_DEBOUNCE_MS);
  }
  async function checkGit() {
    timer = undefined;
    if (running) return void (again = true);
    const ac = (running = new AbortController());
    const at = cwd;
    const result = await exclusive(async () => (ac.signal.aborted ? null : git(at, ac.signal)));
    running = undefined;
    if (!ac.signal.aborted) {
      dirty = result;
      render();
    }
    if (again && live) {
      again = false;
      void checkGit();
    }
  }
  function stopGit() {
    live = false;
    timers.clearTimeout(timer);
    timer = undefined;
    running?.abort();
    again = false;
  }

  const measure = (ctx: ExtensionContext) => {
    contextPercent = ctx.getContextUsage()?.percent ?? null;
  };

  pi.on("session_start", async (_event, ctx) => {
    stopGit();
    if (ctx.mode !== "tui") return;
    totals = branchTotals(ctx);
    measure(ctx);
    perf = reqStart = firstToken = undefined;
    dirty = null;
    cwd = ctx.sessionManager.getCwd(); // one cwd for git and for the footer
    // Trust is on by default for folders without .pi resources; git runs with repo code disabled anyway (shared/git).
    live = ctx.isProjectTrusted();
    if (live) void checkGit();
    const shownCwd = tilde(cwd);
    // Loaded here, not at the top: plain-node tests import this extension without pi-tui.
    const { truncateToWidth } = await import("@earendil-works/pi-tui");
    ctx.ui.setFooter((tui, theme, footerData) => {
      const draw = () => tui.requestRender();
      // requestRender alone would leave the cache below serving last frame's
      // lines: every draw (including a branch change, subscribed below) must
      // also invalidate it.
      const bump = () => {
        version++;
        draw();
      };
      render = bump;
      const unsubscribe = footerData.onBranchChange(bump);
      let cacheKey = "";
      let cached: string[] | undefined;
      return {
        invalidate() {
          cached = undefined; // a theme change redraws with the new colours
        },
        dispose() {
          unsubscribe();
          if (render === bump) render = () => {}; // a newer footer keeps its own
        },
        render: (width: number) => {
          const key = `${width}:${version}`;
          if (cached && cacheKey === key) return cached;
          cacheKey = key;
          return (cached = footerLines(
            {
              model: ctx.model?.id,
              thinking: pi.getThinkingLevel(),
              totals,
              contextPercent,
              cwd: shownCwd,
              branch: footerData.getGitBranch(),
              dirty,
              feed,
              perf,
            },
            theme,
          ).map((line) => truncateToWidth(line, width)));
        },
      };
    });
  });
  pi.on("session_shutdown", stopGit);

  const recount = (_e: unknown, ctx: ExtensionContext) => {
    totals = branchTotals(ctx);
    measure(ctx);
    render();
  };
  pi.on("session_tree", recount);
  pi.on("session_compact", recount);
  pi.on("model_select", (_e, ctx) => {
    measure(ctx);
    render();
  });
  pi.on("thinking_level_select", () => render());
  pi.on("tool_execution_end", scheduleGit);

  pi.on("before_provider_request", () => {
    reqStart = now();
    firstToken = undefined;
  });
  pi.on("message_update", () => {
    if (reqStart === undefined || firstToken !== undefined) return;
    firstToken = now();
    perf = { ttftMs: firstToken - reqStart };
    render();
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; usage?: Usage };
    add(totals, billed(message));
    measure(ctx);
    if (message.role === "assistant" && firstToken !== undefined && reqStart !== undefined) {
      const secs = (now() - firstToken) / 1000;
      perf = { ttftMs: firstToken - reqStart, ...(secs > 0 && { tps: (message.usage?.output ?? 0) / secs }) };
    }
    render();
  });

  return {
    quotas(next: Feed | null | undefined) {
      feed = next;
      render();
    },
  };
}
