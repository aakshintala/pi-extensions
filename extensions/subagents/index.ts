// Subagents core (spec #26, ticket #52): subagent_spawn, subagent_message and
// subagent_stop for top-level children. Each child is a persisted Pi session in
// this process, registered with the shared fleet as an `agent` item; its result
// reaches the parent as a fleet notice. Nesting (#53), worktrees and fork (#54)
// and the transcript viewer (#68) are later tickets.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { duration, fleet, isFinished } from "../../shared/fleet/index.ts";
import { rigSettings } from "../../shared/settings/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { toolRenderers, resultText } from "../../shared/tool-display/index.ts";

const MARKER = "rig.subagent";
const TOOLS = ["subagent_spawn", "subagent_message", "subagent_stop"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STATUSES = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"];
const STATUS_ASK = `\n\nEnd your final message with one line: ${STATUSES.map((s) => `STATUS: ${s}`).join(", ")}.`;
/** Characters of a filed result that the notice still carries. */
const LEAD = 1000;

const SETTINGS = [
  { key: "maxConcurrent", type: "integer", min: 1, max: 64, default: 10, description: "Top-level subagents running at once" },
  { key: "maxInlineChars", type: "integer", min: 1000, max: 1_000_000, default: 16_000, description: "Longest result sent inline; longer ones go to a file" },
] as const;

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
  /** The current run, settled once its notice is sent. */
  run?: Promise<void>;
  shutDown?: Promise<void>;
  stopped: boolean;
  activity: string;
};

export const isChild = (ctx: ExtensionContext) =>
  ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === MARKER);

const str = (description: string) => ({ type: "string", description });
const params = (properties: Record<string, unknown>) => ({ type: "object", required: Object.keys(properties), additionalProperties: false, properties });

function spawnParams(models?: string[]) {
  return params({
    description: str("3-5 word label"),
    prompt: str("The whole task; the child has only this"),
    model: models?.length ? { type: "string", enum: models } : str("provider/id of an enabled model"),
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

export default function (pi: ExtensionAPI) {
  const rig = rigSettings(getAgentDir());
  rig.declare("subagents", SETTINGS);
  // A child session loads this extension too and redeclares the section; read the latest handle.
  const setting = (key: string) => rig.sections().find((s) => s.name === "subagents")!.get(key) as number;

  const agents = new Map<string, Agent>();
  const queue: Agent[] = [];

  const running = () => [...agents.values()].filter((a) => a.state === "running").length;
  function pump() {
    while (queue.length && running() < setting("maxConcurrent")) {
      const a = queue.shift()!;
      a.run = run(a);
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

  /** Runs `session_shutdown` once: ends the child's session-end wait and detaches its fleet delivery. */
  function shutdown(a: Agent) {
    const s = a.session;
    if (!s) return Promise.resolve();
    return (a.shutDown ??= s.extensionRunner.hasHandlers("session_shutdown")
      ? s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => undefined)
      : Promise.resolve());
  }

  async function run(a: Agent) {
    a.state = "running";
    fleet().update(a.id, { status: "running" });
    const began = fleet().now();
    const stats = { turns: 0, tools: 0, tokens: 0, cost: 0 };
    let error: string | undefined;
    let from = 0;
    try {
      const { session } = await createAgentSession({
        cwd: a.cwd,
        agentDir: getAgentDir(),
        model: a.model,
        thinkingLevel: a.thinking as any,
        sessionManager: a.manager,
      });
      a.session = session;
      a.shutDown = undefined;
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
      // source "extension": a child's prompt is not the user's, so FleetView keeps its finished rows.
      if (!a.stopped) await session.prompt(prompt + STATUS_ASK, { source: "extension", expandPromptTemplates: false });
    } catch (e) {
      error = (e as Error).message;
    }
    const replies = (a.session?.messages ?? []).slice(from).filter((m: any) => m.role === "assistant") as any[];
    const last = replies.at(-1);
    const text = [...replies].reverse().map(textOf).find((t) => t.trim()) ?? "";
    if (!a.stopped && !error && last?.stopReason === "error") error = last.errorMessage || "model error";
    await close(a);
    a.state = "done";
    finish(a, text, error, { ...stats, ms: fleet().now() - began });
    pump();
  }

  async function close(a: Agent) {
    if (!a.session) return;
    await shutdown(a);
    a.session.dispose();
    a.session = undefined;
  }

  function finish(a: Agent, text: string, error: string | undefined, s: { turns: number; tools: number; tokens: number; cost: number; ms: number }) {
    const status = a.stopped ? "stopped" : error ? "failed" : "completed";
    const stats = `${count(s.turns, "turn")} · ${count(s.tools, "tool use")} · ${count(s.tokens, "token")} · $${s.cost.toFixed(4)} · ${duration(s.ms)}`;
    const head = `Subagent ${a.id} (${oneLine(a.label)}) ${status}. STATUS: ${a.stopped ? "STOPPED" : error ? "FAILED" : statusOf(text)}\n${stats}`;
    let body = text;
    if (text.length > setting("maxInlineChars")) {
      const file = join(a.manager.getSessionDir(), `${a.manager.getSessionId()}.result.md`);
      writeFileSync(file, text);
      body = `Full result (${count(text.length, "character")}): ${file}\nIt begins:\n${text.slice(0, LEAD)}`;
    }
    const parts = [head];
    if (error) parts.push(`Error: ${error}`);
    if (a.stopped) parts.push(body ? `Partial output, incomplete:\n${body}` : "No output.");
    else if (body) parts.push(body);
    const result = error ? `Error: ${error}` : a.stopped ? "partial output kept" : `STATUS: ${statusOf(text)}`;
    fleet().finish(a.id, status, result, parts.join("\n\n"));
  }

  async function stop(a: Agent) {
    if (a.state === "done") return;
    a.stopped = true;
    if (a.state === "queued") {
      queue.splice(queue.indexOf(a), 1);
      a.state = "done";
      fleet().finish(a.id, "stopped", "stopped before it started", `Subagent ${a.id} (${oneLine(a.label)}) stopped before it started.`);
      return;
    }
    const s = a.session;
    if (!s) return; // still being created: run() sees `stopped` and never prompts
    // Pi reports no event for a bare abort, so stop the child's own work and run its
    // shutdown: either ends a session-end wait that would otherwise hold the abort (#46).
    const child = s.sessionManager.getSessionId();
    for (const item of fleet().items()) if (item.owner === child && !isFinished(item.status)) void item.stop();
    void s.abort();
    await shutdown(a);
  }

  async function message(a: Agent, text: string) {
    if (a.state === "queued") a.prompt += `\n\n${text}`;
    else if (a.state === "running") {
      if (a.session) await a.session.steer(text, undefined, { source: "extension" });
      else a.prompt += `\n\n${text}`; // session still starting: its prompt is not sent yet
    } else {
      a.prompt = text;
      a.stopped = false;
      a.state = "queued";
      register(a);
      queue.push(a);
      pump();
    }
  }

  const find = (id: string) => {
    const a = agents.get(id);
    if (!a) throw new Error(`No subagent ${id}. Use an id that subagent_spawn returned.`);
    return a;
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
      const owner = c.sessionManager.getSessionId();
      const id = randomUUID().slice(0, 8);
      const manager = SessionManager.create(c.cwd, join(c.sessionManager.getSessionDir() || join(getAgentDir(), "sessions"), owner), {
        parentSession: c.sessionManager.getSessionFile(),
      });
      manager.appendCustomEntry(MARKER, { agentId: id, parentSessionId: owner });
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
    async execute(_id: string, p: { id: string; message: string }) {
      const a = find(p.id);
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
    async execute(_id: string, p: { id: string }) {
      const a = find(p.id);
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
    else if (c.scopedModels.length) pi.registerTool(spawnTool(scoped(c)) as any);
  });

  // Stops every child and waits for each to close, so nothing outlives the session.
  pi.on("session_shutdown", async () => {
    const all = [...agents.values()];
    await Promise.all(all.map(stop));
    await Promise.all(all.map((a) => a.run));
    agents.clear();
  });
}
