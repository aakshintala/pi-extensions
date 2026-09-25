// Subagents (spec #26; core #52, nesting #53): subagent_spawn, subagent_message and
// subagent_stop. Each child is a persisted Pi session in this process, registered
// with the shared fleet as an `agent` item; its result reaches the parent as a fleet
// notice. Every session runs this factory, so a child spawns its own children with
// its own instance. The agents form a tree of objects: each instance holds its
// session's node, found for a child through its SessionManager.
// Its viewer content is its transcript (#68, transcript.ts). A child can run in its own git
// worktree (#54, worktree.ts) and start from a copy of its parent's conversation (fork).
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  buildSessionContext,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { duration, fleet, isFinished, type FinalStatus } from "../../shared/fleet/index.ts";
import { rigSettings } from "../../shared/settings/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { isChild, MARKER } from "../../shared/subagent/index.ts";
import { toolRenderers, resultText } from "../../shared/tool-display/index.ts";
import { rememberTools, transcript, type Source } from "./transcript.ts";
import { checkWorktree, createWorktree, reopenWorktree, settleWorktree, type Worktree } from "./worktree.ts";

/** Tokens and cost of a finished child, saved in its parent's session: the parent's next notice and `Session total:` count them. */
const USAGE = "rig.subagent.usage";
/** Saved in an agent's session when its notice is sent: its next notice counts only the usage entries after it. */
const REPORTED = "rig.subagent.reported";
const NOTICE = "rig.notice"; // the fleet extension's notice type
/** Tests set a ModelRuntime here for children to use; unset, Pi builds one per child. */
const RUNTIME = Symbol.for("pi-rig.subagents.modelRuntime");
const TOOLS = ["subagent_spawn", "subagent_message", "subagent_stop"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STATUSES = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"];
const STATUS_ASK = `\n\nEnd your final message with one line: ${STATUSES.map((s) => `STATUS: ${s}`).join(", ")}.`;
/** Characters of a filed result that the notice still carries. */
const LEAD = 1000;
/** Longest wait for a stopped child's own work to stop before its session shuts down. */
const ITEM_STOP_MS = 5000;
/** Longest wait for all of a session's children to stop when it shuts down. */
const SHUTDOWN_MS = 10_000;

const SETTINGS = [
  { key: "maxConcurrent", type: "integer", min: 1, max: 64, default: 10, description: "Top-level subagents running at once" },
  { key: "maxInlineChars", type: "integer", min: 1000, max: 1_000_000, default: 16_000, description: "Longest result sent inline; longer ones go to a file" },
  { key: "maxDepth", type: "integer", min: 1, max: 8, default: 2, description: "Deepest subagent level; agents there get no subagent tools" },
  { key: "maxSessions", type: "integer", min: 2, max: 256, default: 32, description: "Sessions running in one tree of agents, root included" },
] as const;

/** Tokens and cost; the split is zero in usage entries saved before it was kept. */
type Usage = { tokens: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
type Stats = Usage & { turns: number; tools: number; ms: number };
const USAGE_KEYS = ["tokens", "cost", "input", "output", "cacheRead", "cacheWrite"] as const;
const noUsage = (): Usage => ({ tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const usageOf = (u: Usage): Usage => Object.fromEntries(USAGE_KEYS.map((k) => [k, u[k]])) as Usage;
function addUsage(to: Usage, from: Partial<Usage>) {
  for (const k of USAGE_KEYS) to[k] += from[k] ?? 0;
}
/** What a child inherits from its parent (#26 story 8), read when it starts. */
type Inherit = { tools: string[]; prompt?: BuildSystemPromptOptions; models: ExtensionContext["scopedModels"] };

/** A session in a tree of agents: a root (a session that is no agent) or an agent. */
type Node = {
  /** 0 for a root. */
  depth: number;
  /** Children not yet pruned: running, queued, or done with a child that is not. */
  children: Set<Agent>;
  parent?: Node;
  stopped?: boolean;
};
/** `defs`: the tool definitions of the tree's child sessions, for transcripts (transcript.ts). */
type Root = Node & { pump(): void; defs: Map<string, unknown> };

type Agent = Node & Source & {
  id: string;
  /** The parent's session id. */
  owner: string;
  parent: Node;
  root: Root;
  label: string;
  model: NonNullable<ExtensionContext["model"]>;
  thinking: string;
  state: "queued" | "running" | "done";
  /** The next run's prompt: the spawn prompt, a resume message, or those plus messages sent while queued. */
  prompt: string;
  /** Set once the session's first prompt is sent; before that, messages join the prompt. */
  prompted?: boolean;
  /** The current run, settled once its notice is sent. */
  run?: Promise<void>;
  shutDown?: Promise<void>;
  stopped: boolean;
  /** The parent is shutting down: the notice is saved in its session instead of delivered. */
  closing?: boolean;
  activity: string;
  /** Its parent's shutdown gave up waiting: its session is disposed, and it counts toward the cap until its run settles. */
  abandoned?: boolean;
  /** Stops it, in the instance that spawned it. */
  halt?: () => Promise<void>;
  /** Its own git worktree, with isolation "worktree"; `cwd` is inside it. */
  worktree?: Worktree;
  /** Set when a run settles its worktree: whether it was removed. */
  removed?: boolean;
  /** The latest run's counts, for its FleetView row. */
  stats: Omit<Stats, "ms">;
  /** Tokens and cost of its session over every run, plus its children's once they finish: the notice's `Session total`. */
  spent: Usage;
};

/** Agents by id while anything holds them (such as the viewer), so a resume keeps their open transcript. */
const KNOWN = Symbol.for("pi-rig.subagents.known");
const remembered: Map<string, WeakRef<Agent>> = ((globalThis as any)[KNOWN] ??= new Map());
/** Drops an agent's entry once it is collected. */
const forget = new FinalizationRegistry<string>((id) => {
  if (!remembered.get(id)?.deref()) remembered.delete(id);
});

/** Each agent by its SessionManager, so the child session's own instance finds its node. */
const NODES = Symbol.for("pi-rig.subagents.nodes");
const byManager: WeakMap<object, Agent> = ((globalThis as any)[NODES] ??= new WeakMap());

/** Redraws the agent's row and marks its transcript out of date. */
function changed(a: Agent) {
  a.version++;
  fleet().update(a.id);
}

/** Running agents below `n`. A stopped one no longer counts while it winds down, but counts again once abandoned. */
function running(n: Node): number {
  let k = 0;
  for (const a of n.children) k += (a.state === "running" && (!a.stopped || a.abandoned) ? 1 : 0) + running(a);
  return k;
}

/** The agent `id` in `n`'s subtree. */
function search(n: Node, id: string): Agent | undefined {
  for (const a of n.children) {
    const hit = a.id === id ? a : search(a, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Drops a finished agent with no live children from the tree, then its parent if that is now spent too; a resume reads it from disk. */
function prune(a: Agent) {
  if (a.state !== "done" || a.children.size) return;
  a.parent.children.delete(a);
  if ("root" in a.parent) prune(a.parent as Agent);
}

const str = (description: string) => ({ type: "string", description });
const params = (properties: Record<string, unknown>, optional: string[] = []) =>
  ({ type: "object", required: Object.keys(properties).filter((k) => !optional.includes(k)), additionalProperties: false, properties });

function spawnParams(models?: string[]) {
  return params({
    description: str("3-5 word label"),
    prompt: str("The whole task; unless forked, the child has only this"),
    model: models?.length ? { type: "string", enum: models } : str("provider/id"),
    thinking: { type: "string", enum: THINKING },
    isolation: { type: "string", enum: ["none", "worktree"], description: "worktree: its own git worktree on a new branch, kept if it leaves changes" },
    fork: { type: "boolean", description: "Start from a copy of this conversation" },
  }, ["fork"]);
}

const textOf = (m: any): string =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

/** `STATUS: X` from the child's last line that has one. */
const statusOf = (text: string) =>
  text.split("\n").reverse().map((l) => /^\s*\**STATUS:\**\s*([A-Z_]+)/.exec(l)?.[1]).find((s) => s && STATUSES.includes(s)) ?? "none given";

/** enabledModels as `provider/id`, from the session's resolved scope. */
const scoped = (c: ExtensionContext) => [...new Set(c.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`))];

const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** Dollars with two significant digits below a cent: `$0.00003` stays visible. */
export const money = (usd: number) => `$${usd >= 0.01 || usd <= 0 ? usd.toFixed(2) : usd.toFixed(1 - Math.floor(Math.log10(usd)))}`;

/** Tokens as `812`, `41.2k` or `1.3M`. */
const short = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);

/** The notice's `Session total:`: the agent's session over every run, plus the usage its children saved in it. */
function sessionTotal(session: AgentSession, manager: SessionManager): Omit<Stats, "ms"> {
  const s = session.getSessionStats();
  const { total: tokens, ...split } = s.tokens;
  const total = { turns: s.assistantMessages, tools: s.toolCalls, tokens, cost: s.cost, ...split };
  for (const e of manager.getEntries() as any[]) if (e.type === "custom" && e.customType === USAGE) addUsage(total, e.data);
  return total;
}

/** A FleetView row's tokens: `↑12k ↓3.4k 81%`, input, output and the prompt's cache-hit share. */
export const usageText = (u: Usage) => {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return `↑${short(u.input)} ↓${short(u.output)}${prompt ? ` ${Math.round((u.cacheRead / prompt) * 100)}%` : ""}`;
};

const statsLine = (s: Omit<Stats, "ms">) => `${count(s.turns, "turn")} · ${count(s.tools, "tool use")} · ${count(s.tokens, "token")} · ${money(s.cost)}`;

/** Writes via a temp file and rename, so a reader never sees half a result. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Resolves when `p` settles or after `ms`, whichever is first. */
function bounded(p: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => (timer = setTimeout(r, ms)))]).finally(() => clearTimeout(timer));
}

export default function (pi: ExtensionAPI) {
  const rig = rigSettings(getAgentDir());
  // One live section per name (#93): a child session's redeclaration returns this same handle.
  const section = rig.declare("subagents", SETTINGS);
  const setting = (key: string) => section.get(key) as number;

  const queue: Agent[] = [];
  /** The tree's root when this session is no agent. */
  const top: Root = { depth: 0, children: new Set(), pump, defs: new Map() };
  /** This session's node: `top`, or the agent it runs. */
  let node: Node = top;
  let scope: ExtensionContext["scopedModels"] = [];
  /** The parent's prompt sections as of its latest run, for its children. */
  let promptOptions: BuildSystemPromptOptions | undefined;
  pi.on("before_agent_start", (event) => {
    promptOptions = event.systemPromptOptions;
  });

  // The last one read stands in once this session is gone: the user can still resume its children from FleetView.
  let inherited: Inherit = { tools: [], models: [] };
  const inherit = (): Inherit => {
    try {
      return (inherited = { tools: pi.getActiveTools(), prompt: promptOptions, models: scope });
    } catch {
      return inherited;
    }
  };
  /** Starts queued top-level agents while a slot is free and the tree has room. */
  function pump() {
    const slots = () => [...top.children].filter((a) => a.state === "running").length;
    while (queue.length && slots() < setting("maxConcurrent") && 1 + running(top) < setting("maxSessions")) {
      const a = queue.shift()!;
      a.run = run(a, inherit());
    }
  }

  /**
   * A nested spawn or resume starts at once or is refused: it never queues, so a parent
   * waiting on its child cannot deadlock. Refused past maxSessions, and under an agent being stopped.
   */
  function admit() {
    if (node.depth === 0) return;
    for (let n: Node | undefined = node; n; n = n.parent) if (n.stopped) throw new Error("Refused: you are being stopped.");
    const n = 1 + running((node as Agent).root);
    if (n >= setting("maxSessions")) throw new Error(`Refused: your tree of agents already runs ${n} sessions, the most allowed. Wait for one to finish or stop one.`);
  }

  /** Top-level agents queue for a slot; nested ones start at once (admit first). */
  function start(a: Agent) {
    node.children.add(a);
    byManager.set(a.manager, a);
    a.halt = () => stop(a);
    register(a);
    if (node.depth > 0) return void (a.run = run(a, inherit()));
    queue.push(a);
    pump();
  }

  function register(a: Agent) {
    fleet().register({
      id: a.id,
      owner: a.owner,
      kind: "agent",
      label: a.label,
      parentId: "root" in a.parent ? (a.parent as Agent).id : undefined,
      status: a.state === "queued" ? "queued" : "running",
      activity: () => a.activity,
      // ponytail: a running child's tokens join its parent's row when it finishes, as in the notice.
      detail: () => [
        a.model.id,
        a.thinking,
        // Steady fields first; the counts that change go last.
        ...(a.worktree ? [a.removed ? "worktree removed" : a.worktree.branch] : []),
        ...(a.spent.tokens ? [usageText(a.spent)] : []),
        ...(a.spent.cost ? [money(a.spent.cost)] : []),
        ...(a.state === "done" ? [count(a.stats.turns, "turn"), count(a.stats.tools, "tool")] : []),
      ],
      view: { transcript: (tui, ui) => transcript(a, tui as TUI, ui as ExtensionUIContext), showsSteers: true },
      stop: () => stop(a),
      steer: async (text) => {
        await message(a, text);
        changed(a); // the transcript shows the pending steer
      },
    });
  }

  /** Finishes the item. While the parent shuts down its fleet delivery is gone, so the notice is saved in its session. */
  function report(a: Agent, status: FinalStatus, result: string, notice: string) {
    if (!a.closing) return fleet().finish(a.id, status, result, notice);
    fleet().finish(a.id, status, result, null);
    const item = fleet().get(a.id)!;
    const details = { id: a.id, kind: "agent", label: a.label, status, result, ms: (item.endedAt ?? 0) - item.startedAt };
    pi.sendMessage({ customType: NOTICE, content: notice, display: true, details }, { triggerTurn: false });
  }

  /** Runs `session_shutdown` once: ends the child's session-end wait and detaches its fleet delivery. */
  function shutdown(a: Agent) {
    const s = a.session;
    if (!s) return Promise.resolve();
    return (a.shutDown ??= s.extensionRunner.hasHandlers("session_shutdown")
      ? s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => undefined)
      : Promise.resolve());
  }

  async function open(a: Agent, inherit: Inherit) {
    const p = inherit.prompt;
    // The parent's prompt sections replace what the child would discover; without them (no run yet) it discovers its own.
    const resourceLoader = new DefaultResourceLoader({
      cwd: a.cwd,
      agentDir: getAgentDir(),
      ...(p && {
        systemPromptOverride: () => p.customPrompt,
        appendSystemPromptOverride: () => (p.appendSystemPrompt ? [p.appendSystemPrompt] : []),
        agentsFilesOverride: () => ({ agentsFiles: p.contextFiles ?? [] }),
        skillsOverride: () => ({ skills: p.skills ?? [], diagnostics: [] }),
      }),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: a.cwd,
      agentDir: getAgentDir(),
      model: a.model,
      thinkingLevel: a.thinking as any,
      sessionManager: a.manager,
      resourceLoader,
      tools: inherit.tools,
      scopedModels: inherit.models.length ? [...inherit.models] : undefined,
      // Test seam (#120): tests share their in-memory runtime, so no child writes auth.json.
      modelRuntime: (globalThis as any)[RUNTIME],
    });
    return session;
  }

  /**
   * Liveness on the session's bus, in @tintinweb/pi-subagents' vocabulary: pane-pi's card
   * status holds "Working" from each run's start until its end. Best-effort.
   */
  function lane(channel: "subagents:started" | "subagents:completed" | "subagents:failed", a: Agent) {
    try {
      pi.events.emit(channel, { id: a.id });
    } catch {}
  }

  async function run(a: Agent, inherit: Inherit) {
    a.state = "running";
    lane("subagents:started", a);
    fleet().update(a.id, { status: "running" });
    const began = fleet().now();
    const stats = (a.stats = { turns: 0, tools: 0, ...noUsage() });
    let error: string | undefined;
    let from = 0;
    let text = "";
    let total: Omit<Stats, "ms"> | undefined;
    let note: string | undefined;
    try {
      try {
        if (a.worktree) await reopenWorktree(a.worktree);
        a.removed = false;
        const session = (a.session = await open(a, inherit));
        a.spent = sessionTotal(session, a.manager);
        rememberTools(session, a.root.defs);
        a.shutDown = undefined;
        a.prompted = false;
        await session.bindExtensions({});
        session.subscribe((e: any) => {
          if (e.type === "tool_execution_update") a.partial.set(e.toolCallId, e.partialResult);
          else if (e.type === "tool_execution_end") a.partial.delete(e.toolCallId);
          changed(a);
          if (e.type === "turn_end") stats.turns++;
          else if (e.type === "tool_execution_start") {
            stats.tools++;
            const arg = Object.values(e.args ?? {}).find((v) => typeof v === "string") as string | undefined;
            a.activity = `${e.toolName}${arg ? ` ${arg}` : ""}`;
          } else if (e.type === "message_end" && e.message.role === "assistant") {
            const u = e.message.usage;
            const reply = { tokens: u?.totalTokens, cost: u?.cost?.total, input: u?.input, output: u?.output, cacheRead: u?.cacheRead, cacheWrite: u?.cacheWrite };
            addUsage(stats, reply);
            addUsage(a.spent, reply);
            const last = textOf(e.message).trim().split("\n").at(-1);
            if (last) a.activity = last;
          }
        });
        from = session.messages.length;
        const prompt = a.prompt;
        a.prompt = "";
        a.prompted = true;
        // Literal text (no commands or templates), and source "extension": a child's prompt is not the user's.
        if (!a.stopped) await session.prompt(prompt + STATUS_ASK, { source: "extension", expandPromptTemplates: false });
      } catch (e) {
        error = (e as Error).message;
      }
      const replies = (a.session?.messages ?? []).slice(from).filter((m: any) => m.role === "assistant") as any[];
      text = [...replies].reverse().map(textOf).find((t) => t.trim()) ?? "";
      if (!a.stopped && !error && replies.at(-1)?.stopReason === "error") error = replies.at(-1).errorMessage || "model error";
      if (a.session) {
        const t = (a.spent = sessionTotal(a.session, a.manager));
        // A resumed child: the notice also gives the session's totals over every run, with every child's.
        if (from > 0) total = t;
      }
      await close(a);
      if (a.worktree) note = await settle(a);
    } catch (e) {
      error ??= (e as Error).message;
    } finally {
      // An abandoned agent was reported when its parent's shutdown gave up waiting.
      a.state = "done";
      if (!a.abandoned) {
        try {
          finish(a, text, error, { ...stats, ms: fleet().now() - began }, total, note);
        } catch (e) {
          if (!isFinished(fleet().get(a.id)?.status ?? "completed")) report(a, "failed", `Error: ${(e as Error).message}`, `Subagent ${a.id} failed: ${(e as Error).message}`);
        }
      }
      lane(fleet().get(a.id)?.status === "failed" ? "subagents:failed" : "subagents:completed", a);
      prune(a);
      // A finished agent anywhere in the tree may free room for the top level's queue.
      a.root.pump();
    }
  }

  /** Settles the agent's worktree; its row then shows the branch, or that the worktree was removed. */
  async function settle(a: Agent) {
    const note = await settleWorktree(a.worktree!);
    a.removed = !existsSync(a.worktree!.path);
    return note;
  }

  async function close(a: Agent) {
    if (!a.session) return;
    await shutdown(a);
    a.session.dispose();
    a.session = undefined;
    changed(a); // an open transcript draws the final saved tail
  }

  function finish(a: Agent, text: string, error: string | undefined, s: Stats, total?: Omit<Stats, "ms">, note?: string) {
    // Tokens and cost roll up through the sessions: this notice counts the children that
    // finished since the last one, which holds across pruning and restarts.
    const entries = a.manager.getEntries() as any[];
    const last = entries.findLastIndex((e) => e.type === "custom" && e.customType === REPORTED);
    s = { ...s };
    for (const e of entries.slice(last + 1)) if (e.type === "custom" && e.customType === USAGE) addUsage(s, e.data);
    a.manager.appendCustomEntry(REPORTED, {});
    const usage = usageOf(s);
    if ("root" in a.parent) {
      const p = a.parent as Agent;
      p.manager.appendCustomEntry(USAGE, usage);
      addUsage(p.spent, usage);
    } else pi.appendEntry(USAGE, usage); // the root session: its footer counts it
    const status = a.stopped ? "stopped" : error ? "failed" : "completed";
    const lines = [`${statsLine(s)} · ${duration(s.ms)}`, ...(total ? [`Session total: ${statsLine(total)}`] : []), ...(note ? [note] : [])];
    const head = `Subagent ${a.id} (${oneLine(a.label)}) ${status}. STATUS: ${a.stopped ? "STOPPED" : error ? "FAILED" : statusOf(text)}\n${lines.join("\n")}`;
    let body = text;
    const max = setting("maxInlineChars");
    if (text.length > max) {
      const file = join(a.manager.getSessionDir(), `${a.id}.result.md`);
      try {
        writeAtomic(file, text);
        body = `Full result (${count(text.length, "character")}): ${file}\nIt begins:\n${text.slice(0, LEAD)}`;
      } catch (e) {
        body = `Could not save the full result (${(e as Error).message}). Truncated to its first ${count(max, "character")}:\n${text.slice(0, max)}`;
      }
    }
    const parts = [head];
    if (error) parts.push(`Error: ${error}`);
    if (a.stopped) parts.push(body ? `Partial output, incomplete:\n${body}` : "No output.");
    else if (body) parts.push(body);
    const result = error ? `Error: ${error}` : a.stopped ? "partial output kept" : `STATUS: ${statusOf(text)}`;
    report(a, status, result, parts.join("\n\n"));
  }

  async function stop(a: Agent) {
    if (a.state === "done") return;
    // First: from here it counts out of the tree's cap, and spawns below it are refused.
    a.stopped = true;
    a.root.pump();
    if (a.state === "queued") {
      const i = queue.indexOf(a);
      if (i >= 0) queue.splice(i, 1);
      a.state = "done";
      const note = a.worktree ? `\n${await settle(a)}` : "";
      report(a, "stopped", "stopped before it started", `Subagent ${a.id} (${oneLine(a.label)}) stopped before it started.${note}`);
      prune(a);
      return;
    }
    const s = a.session;
    if (!s) return; // still being created: run() sees `stopped` and never prompts
    // Pi reports no event for a bare abort, so stop the child's own work (bounded), then
    // run its shutdown: either ends a session-end wait that would otherwise hold the abort (#46).
    const child = s.sessionManager.getSessionId();
    const owned = fleet().items().filter((item) => item.owner === child && !isFinished(item.status));
    void s.abort();
    await bounded(Promise.allSettled(owned.map((item) => Promise.resolve().then(() => item.stop()))), ITEM_STOP_MS);
    await shutdown(a);
  }

  async function message(a: Agent, text: string) {
    if (a.state === "queued") a.prompt += `\n\n${text}`;
    else if (a.state === "running") {
      // Before its first prompt, the message joins it. After, it is a literal steer: no commands or templates.
      if (a.session && a.prompted) await a.session.prompt(text, { source: "extension", expandPromptTemplates: false, streamingBehavior: "steer" });
      else a.prompt += `\n\n${text}`;
    } else {
      admit();
      a.prompt = text;
      a.stopped = false;
      a.state = "queued";
      start(a);
    }
  }

  /** Where worktrees are made, one per agent id. */
  const worktrees = () => join(getAgentDir(), "rig-worktrees");

  /** Where this session's children are saved: a folder named after it, beside its own file. */
  const childDir = (c: ExtensionContext) =>
    join(c.sessionManager.getSessionDir() || join(getAgentDir(), "sessions"), c.sessionManager.getSessionId());

  /** A saved child of this session: its file, read without writing, and its marker. */
  function saved(id: string, c: ExtensionContext) {
    const dir = childDir(c);
    if (!/^[0-9a-f]{8}$/.test(id) || !existsSync(dir)) return undefined;
    const name = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
    if (!name) return undefined;
    const file = join(dir, name);
    const entries: any[] = parseSessionEntries(readFileSync(file, "utf8"));
    const marker = entries.find((e) => e.type === "custom" && e.customType === MARKER);
    if (marker?.data?.agentId !== id || marker.data.parentSessionId !== c.sessionManager.getSessionId()) return undefined;
    return { file, marker, entries };
  }

  /** A finished child of this session, to resume: still in memory, or reopened from its session file. */
  async function restore(id: string, c: ExtensionContext): Promise<Agent | undefined> {
    // Still in memory (its transcript may be open): the same agent. The owner check keeps it under the
    // session that spawned it; `node` is that session's node, new if the session was reopened.
    const held = remembered.get(id)?.deref();
    if (held?.state === "done" && held.owner === c.sessionManager.getSessionId()) return Object.assign(held, { parent: node, root: "root" in node ? (node as Agent).root : top });
    const found = saved(id, c);
    if (!found) return undefined;
    // The model is checked before the file is opened: opening can write to it.
    const context = buildSessionContext(found.entries.filter((e) => e.type !== "session"));
    const model = context.model && c.modelRegistry.find(context.model.provider, context.model.modelId);
    if (!model) return undefined;
    // Checked like the model, before the file is opened: the saved entry must name the worktree the spawn made.
    const kept = found.marker.data.worktree;
    const worktree = kept === undefined ? undefined : await checkWorktree(kept, id, worktrees(), c.cwd);
    const manager = SessionManager.open(found.file); // the resume writes to it
    const owner = c.sessionManager.getSessionId();
    const fields = { id, owner, depth: found.marker.data.depth ?? node.depth + 1, label: manager.getSessionName() ?? id, model, thinking: context.thinkingLevel, state: "done" as const };
    return agent({ ...fields, prompt: "", cwd: worktree?.cwd ?? c.cwd, manager, worktree });
  }

  /** A new agent below this session. */
  function agent(fields: Omit<Agent, "parent" | "root" | "children" | "stopped" | "activity" | "partial" | "version" | "stats" | "spent">): Agent {
    const a: Agent = {
      ...fields,
      parent: node,
      root: "root" in node ? (node as Agent).root : top,
      children: new Set(),
      stopped: false,
      activity: "",
      partial: new Map(),
      version: 0,
      stats: { turns: 0, tools: 0, ...noUsage() },
      spent: noUsage(),
    };
    remembered.set(a.id, new WeakRef(a));
    forget.register(a, a.id);
    return a;
  }

  /** Only the session that spawned a child can message it. */
  const find = async (id: string, c: ExtensionContext) => {
    const owner = c.sessionManager.getSessionId();
    const a = [...node.children].find((x) => x.id === id);
    const mine = a && a.owner === owner ? a : !a ? await restore(id, c) : undefined;
    if (!mine) throw new Error(`No subagent ${id} of yours. Use an id that your subagent_spawn returned.`);
    return mine;
  };
  const reply = (text: string, id: string) => ({ content: [{ type: "text" as const, text }], details: { id } });

  const spawnTool = (models?: string[]) => ({
    name: "subagent_spawn",
    label: "Agent",
    description:
      "Start a subagent: a background copy of you with the same instructions and tools, and a fresh context unless forked. Returns its id at once; " +
      "its full result arrives later as a notice, so end your turn to wait. " +
      "Pick the cheapest model and thinking level that can do the task.",
    parameters: spawnParams(models),
    async execute(_id: string, p: { description: string; prompt: string; model: string; thinking: string; isolation: string; fork?: boolean }, signal: AbortSignal | undefined, _update: unknown, c: ExtensionContext) {
      // enabledModels when set, else every model Pi knows; a model without credentials fails in the child.
      const allowed = c.scopedModels.length ? c.scopedModels.map((s) => s.model) : c.modelRegistry.getAll();
      const model = allowed.find((m) => `${m.provider}/${m.id}` === p.model);
      if (!model) throw new Error(`Unknown model "${p.model}".${c.scopedModels.length ? ` Use one of: ${scoped(c).join(", ")}.` : ""}`);
      // Pi would silently clamp an unsupported level; refuse it instead.
      const levels = getSupportedThinkingLevels(model as any) as string[];
      if (!levels.includes(p.thinking)) throw new Error(`${p.model} cannot think at "${p.thinking}". Use one of: ${levels.join(", ")}.`);
      const owner = c.sessionManager.getSessionId();
      admit();
      // The child's session id is its agent id, so a later process can find its file.
      const id = randomUUID().slice(0, 8);
      const worktree = p.isolation === "worktree" ? await createWorktree(c.cwd, worktrees(), id, signal) : undefined;
      const cwd = worktree?.cwd ?? c.cwd;
      const manager = SessionManager.create(cwd, childDir(c), { id, parentSession: c.sessionManager.getSessionFile() });
      manager.appendCustomEntry(MARKER, { agentId: id, parentSessionId: owner, depth: node.depth + 1, ...(worktree && { worktree }) });
      manager.appendSessionInfo(p.description);
      // A fork copies what the parent's model sees now: compacted history as its summary, then the rest.
      if (p.fork) for (const m of c.sessionManager.buildSessionProjection().messages) manager.appendMessage(m as any);
      const a = agent({ id, owner, depth: node.depth + 1, label: p.description, model, thinking: p.thinking, state: "queued", prompt: p.prompt, cwd, manager, worktree });
      start(a);
      return reply(`Subagent ${id} ${a.state === "queued" ? "queued" : "started"}${worktree ? ` in worktree ${worktree.path} (branch ${worktree.branch})` : ""}.`, id);
    },
    ...toolRenderers({
      title: "Agent",
      arg: (args: any) => oneLine(args?.description ?? ""),
      summary: { verb: "started", one: "subagent" },
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  });

  pi.registerTool(spawnTool() as any);
  pi.registerTool({
    name: "subagent_message",
    label: "Message",
    description:
      "Message one of your subagents. A running one reads it after its current step; a finished one resumes from its saved session and sends a new notice; " +
      "a queued one gets it added to its prompt. Answer NEEDS_CONTEXT here.",
    parameters: params({ id: str("Subagent id"), message: str("What to tell it") }),
    async execute(_id: string, p: { id: string; message: string }, _signal: unknown, _update: unknown, c: ExtensionContext) {
      const a = await find(p.id, c);
      const was = a.state;
      await message(a, p.message);
      return reply(`Subagent ${a.id} ${was === "done" ? (a.state === "queued" ? "queued to resume" : "resumed") : was === "queued" ? "prompt extended" : "steered"}.`, a.id);
    },
    ...toolRenderers({
      title: "Message",
      arg: (args: any) => oneLine(args?.id ?? ""),
      summary: { verb: "messaged", one: "subagent" },
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);
  pi.registerTool({
    name: "subagent_stop",
    label: "Stop",
    description: "Stop any agent below you: one of your subagents or one of theirs. Every agent under it stops too. Its notice carries its partial output, marked incomplete.",
    parameters: params({ id: str("Subagent id") }),
    async execute(_id: string, p: { id: string }, _signal: unknown, _update: unknown, c: ExtensionContext) {
      // Only this session's subtree: its own children, and theirs, through their parent chain.
      const me = c.sessionManager.getSessionId();
      const known = search(node, p.id);
      let mine = false;
      for (let x: Node | undefined = known; x && "root" in x; x = x.parent) if ((x as Agent).owner === me) mine = true;
      const a = known && mine ? known : undefined;
      // Not running here: a finished child of this session, found without opening its file for writing.
      const held = remembered.get(p.id)?.deref();
      if (!known && ((held?.state === "done" && held.owner === me) || saved(p.id, c))) return reply(`Subagent ${p.id} already finished.`, p.id);
      if (!a) throw new Error(`No subagent ${p.id} below you.`);
      if (a.state === "done") return reply(`Subagent ${a.id} already finished.`, a.id);
      // An agent below a child belongs to that child's instance, which stops it.
      await a.halt?.();
      return reply(`Subagent ${a.id} stopped.`, a.id);
    },
    ...toolRenderers({
      title: "Stop",
      arg: (args: any) => oneLine(args?.id ?? ""),
      summary: { verb: "stopped", one: "subagent" },
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);

  pi.on("session_start", (_event, c) => {
    // A child session opened outside its tree (its parent is not running here) is treated as at the cap.
    node = byManager.get(c.sessionManager) ?? (isChild(c) ? { depth: Infinity, children: new Set() } : top);
    scope = c.scopedModels;
    if (node.depth >= setting("maxDepth")) pi.setActiveTools(pi.getActiveTools().filter((t) => !TOOLS.includes(t)));
    // Same name: Pi keeps one definition per name, so this replaces the base tool.
    else if (c.scopedModels.length) pi.registerTool(spawnTool(scoped(c)) as any);
  });

  // Stops every child and waits for each to close, so nothing outlives the session. The
  // fleet may already have detached this session, so each notice is saved in it instead.
  // A child that will not stop (a stream ignoring its abort) is given up on after SHUTDOWN_MS, so the whole cascade is bounded.
  pi.on("session_shutdown", async () => {
    const all = [...node.children];
    for (const a of all) a.closing = true;
    await bounded(Promise.all(all.map(stop)).then(() => Promise.all(all.map((a) => a.run))), SHUTDOWN_MS);
    for (const a of all) {
      if (a.state === "done") continue;
      // Given up on: reported now and its session disposed, so it spends nothing more. It stays in
      // the tree, counting toward the cap, until its run settles and prunes it.
      a.abandoned = true;
      report(a, "stopped", "did not stop in time", `Subagent ${a.id} (${oneLine(a.label)}) stopped. It did not stop within ${SHUTDOWN_MS / 1000}s, so its session was abandoned.`);
      const session = a.session;
      if (session) void shutdown(a).finally(() => session.dispose());
      a.session = undefined;
    }
    for (const a of all) if (!a.abandoned) node.children.delete(a);
    top.defs.clear();
  });
}
