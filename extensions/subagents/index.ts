// Subagents core (spec #26, ticket #52): subagent_spawn, subagent_message and
// subagent_stop for top-level children. Each child is a persisted Pi session in
// this process, registered with the shared fleet as an `agent` item; its result
// reaches the parent as a fleet notice. Nesting (#53), worktrees and fork (#54)
// and the transcript viewer (#68) are later tickets.
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { duration, fleet, isFinished, type FinalStatus } from "../../shared/fleet/index.ts";
import { rigSettings } from "../../shared/settings/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { toolRenderers, resultText } from "../../shared/tool-display/index.ts";

const MARKER = "rig.subagent";
const NOTICE = "rig.notice"; // the fleet extension's notice type
const TOOLS = ["subagent_spawn", "subagent_message", "subagent_stop"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STATUSES = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"];
const STATUS_ASK = `\n\nEnd your final message with one line: ${STATUSES.map((s) => `STATUS: ${s}`).join(", ")}.`;
/** Characters of a filed result that the notice still carries. */
const LEAD = 1000;
/** Longest wait for a stopped child's own work to stop before its session shuts down. */
const ITEM_STOP_MS = 5000;

const SETTINGS = [
  { key: "maxConcurrent", type: "integer", min: 1, max: 64, default: 10, description: "Top-level subagents running at once" },
  { key: "maxInlineChars", type: "integer", min: 1000, max: 1_000_000, default: 16_000, description: "Longest result sent inline; longer ones go to a file" },
] as const;

type Stats = { turns: number; tools: number; tokens: number; cost: number; ms: number };
/** What a child inherits from its parent (#26 story 8), read when it starts. */
type Inherit = { tools: string[]; prompt?: BuildSystemPromptOptions };

type Agent = {
  id: string;
  owner: string;
  label: string;
  model: NonNullable<ExtensionContext["model"]>;
  thinking: string;
  state: "queued" | "running" | "done";
  /** The next run's prompt: the spawn prompt, a resume message, or those plus messages sent while queued. */
  prompt: string;
  cwd: string;
  manager: SessionManager;
  session?: AgentSession;
  /** Set once the session's first prompt is sent; before that, messages join the prompt. */
  prompted?: boolean;
  /** The current run, settled once its notice is sent. */
  run?: Promise<void>;
  shutDown?: Promise<void>;
  stopped: boolean;
  /** The parent is shutting down: the notice is saved in its session instead of delivered. */
  closing?: boolean;
  activity: string;
};

export const isChild = (ctx: Pick<ExtensionContext, "sessionManager">) =>
  ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === MARKER);

const str = (description: string) => ({ type: "string", description });
const params = (properties: Record<string, unknown>) => ({ type: "object", required: Object.keys(properties), additionalProperties: false, properties });

function spawnParams(models?: string[]) {
  return params({
    description: str("3-5 word label"),
    prompt: str("The whole task; the child has only this"),
    model: models?.length ? { type: "string", enum: models } : str("provider/id"),
    thinking: { type: "string", enum: THINKING },
  });
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

  const agents = new Map<string, Agent>();
  const queue: Agent[] = [];
  /** The parent's prompt sections as of its latest run, for its children. */
  let promptOptions: BuildSystemPromptOptions | undefined;
  pi.on("before_agent_start", (event) => {
    promptOptions = event.systemPromptOptions;
  });

  const running = () => [...agents.values()].filter((a) => a.state === "running").length;
  function pump() {
    while (queue.length && running() < setting("maxConcurrent")) {
      const a = queue.shift()!;
      a.run = run(a, { tools: pi.getActiveTools(), prompt: promptOptions });
    }
  }

  function register(a: Agent) {
    fleet().register({
      id: a.id,
      owner: a.owner,
      kind: "agent",
      label: a.label,
      status: a.state === "queued" ? "queued" : "running",
      activity: () => a.activity,
      // ponytail: the transcript viewer is #68; until then the item shows where the session lives.
      view: { transcript: () => new Text(`Session: ${a.manager.getSessionFile() ?? "not saved yet"}`, 0, 0) },
      stop: () => stop(a),
      steer: (text) => message(a, text),
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
    });
    return session;
  }

  async function run(a: Agent, inherit: Inherit) {
    a.state = "running";
    fleet().update(a.id, { status: "running" });
    const began = fleet().now();
    const stats = { turns: 0, tools: 0, tokens: 0, cost: 0 };
    let error: string | undefined;
    let from = 0;
    let text = "";
    let total: Omit<Stats, "ms"> | undefined;
    try {
      try {
        const session = (a.session = await open(a, inherit));
        a.shutDown = undefined;
        a.prompted = false;
        await session.bindExtensions({});
        session.subscribe((e: any) => {
          if (e.type === "turn_end") stats.turns++;
          else if (e.type === "tool_execution_start") {
            stats.tools++;
            const arg = Object.values(e.args ?? {}).find((v) => typeof v === "string") as string | undefined;
            a.activity = `${e.toolName}${arg ? ` ${arg}` : ""}`;
          } else if (e.type === "message_end" && e.message.role === "assistant") {
            stats.tokens += e.message.usage?.totalTokens ?? 0;
            stats.cost += e.message.usage?.cost?.total ?? 0;
            const last = textOf(e.message).trim().split("\n").at(-1);
            if (last) a.activity = last;
          } else return;
          fleet().update(a.id);
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
      if (from > 0 && a.session) {
        // A resumed child: the notice also gives the session's totals over every run.
        const s = a.session.getSessionStats();
        total = { turns: s.assistantMessages, tools: s.toolCalls, tokens: s.tokens.total, cost: s.cost };
      }
      await close(a);
    } catch (e) {
      error ??= (e as Error).message;
    } finally {
      a.state = "done";
      try {
        finish(a, text, error, { ...stats, ms: fleet().now() - began }, total);
      } catch (e) {
        if (!isFinished(fleet().get(a.id)?.status ?? "completed")) report(a, "failed", `Error: ${(e as Error).message}`, `Subagent ${a.id} failed: ${(e as Error).message}`);
      }
      pump();
    }
  }

  async function close(a: Agent) {
    if (!a.session) return;
    await shutdown(a);
    a.session.dispose();
    a.session = undefined;
  }

  function finish(a: Agent, text: string, error: string | undefined, s: Stats, total?: Omit<Stats, "ms">) {
    const status = a.stopped ? "stopped" : error ? "failed" : "completed";
    const lines = [`${statsLine(s)} · ${duration(s.ms)}`, ...(total ? [`Session total: ${statsLine(total)}`] : [])];
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
    a.stopped = true;
    if (a.state === "queued") {
      const i = queue.indexOf(a);
      if (i >= 0) queue.splice(i, 1);
      a.state = "done";
      report(a, "stopped", "stopped before it started", `Subagent ${a.id} (${oneLine(a.label)}) stopped before it started.`);
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
      a.prompt = text;
      a.stopped = false;
      a.state = "queued";
      register(a);
      queue.push(a);
      pump();
    }
  }

  /** Where this session's children are saved: a folder named after it, beside its own file. */
  const childDir = (c: ExtensionContext) =>
    join(c.sessionManager.getSessionDir() || join(getAgentDir(), "sessions"), c.sessionManager.getSessionId());

  /** A child of this session saved by an earlier process: reopened from its session file. */
  function restore(id: string, c: ExtensionContext): Agent | undefined {
    const dir = childDir(c);
    if (!/^[0-9a-f]{8}$/.test(id) || !existsSync(dir)) return undefined;
    const file = readdirSync(dir).find((f) => f.endsWith(`_${id}.jsonl`));
    if (!file) return undefined;
    const manager = SessionManager.open(join(dir, file));
    const marker: any = manager.getEntries().find((e) => e.type === "custom" && e.customType === MARKER);
    const owner = c.sessionManager.getSessionId();
    if (marker?.data?.agentId !== id || marker.data.parentSessionId !== owner) return undefined;
    const saved = manager.buildSessionContext();
    const model = saved.model && c.modelRegistry.find(saved.model.provider, saved.model.modelId);
    if (!model) return undefined;
    const a: Agent = { id, owner, label: manager.getSessionName() ?? id, model, thinking: saved.thinkingLevel, state: "done", prompt: "", cwd: c.cwd, manager, stopped: false, activity: "" };
    agents.set(id, a);
    return a;
  }

  /** Only the session that spawned a child can message or stop it. */
  const find = (id: string, c: ExtensionContext) => {
    const owner = c.sessionManager.getSessionId();
    const a = agents.get(id);
    const mine = a && a.owner === owner ? a : !a ? restore(id, c) : undefined;
    if (!mine) throw new Error(`No subagent ${id} of yours. Use an id that your subagent_spawn returned.`);
    return mine;
  };
  const reply = (text: string, id: string) => ({ content: [{ type: "text" as const, text }], details: { id } });

  const spawnTool = (models?: string[]) => ({
    name: "subagent_spawn",
    label: "Agent",
    description:
      "Start a subagent: a background copy of you with the same instructions and tools but a fresh context. Returns its id at once; " +
      "its full result arrives later as a notice, so end your turn to wait. " +
      "Pick the cheapest model and thinking level that can do the task.",
    parameters: spawnParams(models),
    async execute(_id: string, p: { description: string; prompt: string; model: string; thinking: string }, _signal: unknown, _update: unknown, c: ExtensionContext) {
      // enabledModels when set, else every model Pi knows; a model without credentials fails in the child.
      const allowed = c.scopedModels.length ? c.scopedModels.map((s) => s.model) : c.modelRegistry.getAll();
      const model = allowed.find((m) => `${m.provider}/${m.id}` === p.model);
      if (!model) throw new Error(`Unknown model "${p.model}".${c.scopedModels.length ? ` Use one of: ${scoped(c).join(", ")}.` : ""}`);
      // Pi would silently clamp an unsupported level; refuse it instead.
      const levels = getSupportedThinkingLevels(model as any) as string[];
      if (!levels.includes(p.thinking)) throw new Error(`${p.model} cannot think at "${p.thinking}". Use one of: ${levels.join(", ")}.`);
      const owner = c.sessionManager.getSessionId();
      // The child's session id is its agent id, so a later process can find its file.
      const id = randomUUID().slice(0, 8);
      const manager = SessionManager.create(c.cwd, childDir(c), { id, parentSession: c.sessionManager.getSessionFile() });
      manager.appendCustomEntry(MARKER, { agentId: id, parentSessionId: owner });
      manager.appendSessionInfo(p.description);
      const a: Agent = { id, owner, label: p.description, model, thinking: p.thinking, state: "queued", prompt: p.prompt, cwd: c.cwd, manager, stopped: false, activity: "" };
      agents.set(id, a);
      register(a);
      queue.push(a);
      pump();
      return reply(`Subagent ${id} ${a.state === "queued" ? "queued" : "started"}.`, id);
    },
    ...toolRenderers({
      title: "Agent",
      arg: (args: any) => oneLine(args?.description ?? ""),
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
      const a = find(p.id, c);
      const was = a.state;
      await message(a, p.message);
      return reply(`Subagent ${a.id} ${was === "done" ? (a.state === "queued" ? "queued to resume" : "resumed") : was === "queued" ? "prompt extended" : "steered"}.`, a.id);
    },
    ...toolRenderers({
      title: "Message",
      arg: (args: any) => oneLine(args?.id ?? ""),
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);
  pi.registerTool({
    name: "subagent_stop",
    label: "Stop",
    description: "Stop a subagent. Its notice carries its partial output, marked incomplete.",
    parameters: params({ id: str("Subagent id") }),
    async execute(_id: string, p: { id: string }, _signal: unknown, _update: unknown, c: ExtensionContext) {
      const a = find(p.id, c);
      if (a.state === "done") return reply(`Subagent ${a.id} already finished.`, a.id);
      await stop(a);
      return reply(`Subagent ${a.id} stopped.`, a.id);
    },
    ...toolRenderers({
      title: "Stop",
      arg: (args: any) => oneLine(args?.id ?? ""),
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);

  pi.on("session_start", (_event, c) => {
    // Nesting is #53: until then a child gets none of these tools.
    if (isChild(c)) pi.setActiveTools(pi.getActiveTools().filter((t) => !TOOLS.includes(t)));
    // Same name: Pi keeps one definition per name, so this replaces the base tool.
    else if (c.scopedModels.length) pi.registerTool(spawnTool(scoped(c)) as any);
  });

  // Stops every child and waits for each to close, so nothing outlives the session. The
  // fleet may already have detached this session, so each notice is saved in it instead.
  pi.on("session_shutdown", async () => {
    const all = [...agents.values()];
    for (const a of all) a.closing = true;
    await Promise.all(all.map(stop));
    await Promise.all(all.map((a) => a.run));
    agents.clear();
  });
}
