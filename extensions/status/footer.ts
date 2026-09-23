// The rig's two-line footer (spec #38, ticket #66).
//   model · thinking │ in out cache $ │ ctx bar
//   cwd branch* │ Q quotas │ TTFT · TPS
// Usage totals update from events, not a scan per draw. Git dirty state is
// checked asynchronously, debounced after tool calls, one git at a time.
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Feed } from "./quota.ts";

export const GIT_DEBOUNCE_MS = 300;
const GIT_TIMEOUT_MS = 5_000;
const CTX_WARN = 70, CTX_DANGER = 90;
const QUOTA_WARN = 50, QUOTA_DANGER = 20;

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
/** Resolves true when the work tree has changes, false when clean, null when not a repo or git failed. */
export type GitDirty = (cwd: string, signal: AbortSignal) => Promise<boolean | null>;

export interface FooterDeps {
  timers?: Timers;
  now?: () => number;
  gitDirty?: GitDirty;
}

// --no-optional-locks: a background status must not take index.lock from the user's git.
const gitDirty: GitDirty = (cwd, signal) =>
  new Promise((resolve) =>
    execFile("git", ["--no-optional-locks", "status", "--porcelain"], { cwd, signal, timeout: GIT_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout.length > 0),
    ),
  );

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

export const tokens = (n: number) =>
  n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`;

export interface Snapshot {
  model?: string;
  thinking?: string;
  totals: Totals;
  contextPercent: number | null;
  cwd: string;
  branch: string | null;
  dirty: boolean | null;
  /** undefined before the first quota result, null when QuotaBar is unreachable. */
  feed: Feed | null | undefined;
  perf?: { ttftMs: number; tps?: number };
}

/** The footer's two lines, before truncation to the terminal width. */
export function footerLines(s: Snapshot, theme: Pick<Theme, "fg">): string[] {
  const fg = theme.fg.bind(theme);
  const dim = (x: string) => fg("dim", x);
  const sep = `  ${dim("│")}  `;

  const top: string[] = [];
  const head = [s.model && fg("accent", s.model), s.thinking && fg(`thinking${s.thinking[0].toUpperCase()}${s.thinking.slice(1)}` as never, s.thinking)];
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

  const bottom = [s.branch ? `${s.cwd} ${fg("accent", s.branch)}${s.dirty ? fg("warning", "*") : ""}` : s.cwd];
  if (s.feed === null) bottom.push(dim("Q unavailable"));
  else if (s.feed) {
    const parts = s.feed.providers
      .filter((pr) => !pr.unavailable && pr.quotas.length)
      .map((pr) => {
        const pcts = pr.quotas.map((q) => Math.round(q.percentRemaining));
        const min = Math.min(...pcts);
        return fg(min < QUOTA_DANGER ? "error" : min < QUOTA_WARN ? "warning" : "text", `${pr.id} ${pcts.map((v) => `${v}%`).join("/")}`);
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

/** Registers the footer. Returns `quotas`, which the quota client's fetch tap calls with each feed (null on failure). */
export function registerFooter(pi: ExtensionAPI, { timers = globalThis, now = Date.now, gitDirty: git = gitDirty }: FooterDeps = {}) {
  let totals = zero();
  let feed: Feed | null | undefined;
  let dirty: boolean | null = null;
  let perf: Snapshot["perf"];
  let reqStart: number | undefined, firstToken: number | undefined;
  let render = () => {};

  // Git: one debounce timer, at most one git process; a request during a run reruns once after it.
  let cwd = "";
  let live = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | undefined;
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
    const result = await git(cwd, ac.signal);
    if (running !== ac) return; // stopped meanwhile
    running = undefined;
    dirty = result;
    render();
    if (again) {
      again = false;
      void checkGit();
    }
  }
  function stopGit() {
    live = false;
    timers.clearTimeout(timer);
    timer = undefined;
    running?.abort();
    running = undefined;
    again = false;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    totals = branchTotals(ctx);
    perf = reqStart = firstToken = undefined;
    dirty = null;
    cwd = ctx.cwd;
    // git status can run repo hooks (core.fsmonitor), so only in trusted projects.
    live = ctx.isProjectTrusted();
    if (live) void checkGit();
    // Loaded here, not at the top: plain-node tests import this extension without pi-tui.
    const { truncateToWidth } = await import("@earendil-works/pi-tui");
    ctx.ui.setFooter((tui, theme, footerData) => {
      render = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(render);
      return {
        invalidate() {},
        dispose() {
          unsubscribe();
          render = () => {};
        },
        render: (width: number) =>
          footerLines(
            {
              model: ctx.model?.id,
              thinking: pi.getThinkingLevel(),
              totals,
              contextPercent: ctx.getContextUsage()?.percent ?? null,
              cwd: tilde(ctx.sessionManager.getCwd()),
              branch: footerData.getGitBranch(),
              dirty,
              feed,
              perf,
            },
            theme,
          ).map((line) => truncateToWidth(line, width)),
      };
    });
  });
  pi.on("session_shutdown", stopGit);

  const recount = (_e: unknown, ctx: ExtensionContext) => {
    totals = branchTotals(ctx);
    render();
  };
  pi.on("session_tree", recount);
  pi.on("session_compact", recount);
  pi.on("model_select", () => render());
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
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; usage?: Usage };
    add(totals, billed(message));
    if (message.role === "assistant" && firstToken !== undefined && reqStart !== undefined) {
      const secs = (now() - firstToken) / 1000;
      perf = { ttftMs: firstToken - reqStart, ...(secs > 0 && { tps: (message.usage?.output ?? 0) / secs }) };
    }
    render();
  });

  return {
    quotas(next: Feed | null) {
      feed = next;
      render();
    },
  };
}
