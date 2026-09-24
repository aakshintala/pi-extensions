// An agent's transcript for the fleet viewer (#68): its saved session drawn with Pi's
// own message components, tool calls grouped as in the main chat (#56), and followed
// live while the agent runs. It is pull-based: a render after the agent reports a change
// appends the session entries added since the last one (a walk back from the leaf, never
// a rescan) and redraws the streaming message, so it holds no listener. A compaction is
// an entry appended after the last one drawn, so the earlier messages stay on screen, as
// the main chat keeps its scrollback; the summary itself is not drawn. The viewer
// builds one on each open and disposes it on close, which releases its tool groups.
// It reads the agent's in-memory SessionManager only: no file is opened or written here.
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  getMarkdownTheme,
  sessionEntryToContextMessages,
  SettingsManager,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSession,
  type ExtensionUIContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { ToolGroups } from "../../shared/tool-display/index.ts";
import { oneLine } from "../../shared/text/index.ts";

/** Most messages drawn when a transcript opens; earlier ones are counted on one line. */
export const OPEN_MESSAGES = 200;

/** What a transcript reads from an agent. */
export interface Source {
  manager: SessionManager;
  cwd: string;
  session?: AgentSession;
  /** Partial results of running calls, by call id. */
  partial: Map<string, { isError?: boolean }>;
  /** Bumped on every session event. */
  version: number;
  /**
   * The tool definitions of the child sessions its tree has run, the rig's own renderers
   * included (they carry the group summaries), for drawing its calls when it has no live
   * session. Held by the tree's root session, so they go with it.
   */
  root: { defs: Map<string, unknown> };
}

/** Records a child session's tool definitions in its tree's `defs` (call when it opens). */
export function rememberTools(session: AgentSession, defs: Map<string, unknown>) {
  for (const t of session.getAllTools()) defs.set(t.name, session.getToolDefinition(t.name));
}

/**
 * Built-ins, when no child session of the tree has run yet: after a restart or /reload,
 * until one does, a finished agent's calls draw with Pi's stock renderers, ungrouped.
 */
const BUILT_INS: Record<string, (cwd: string) => unknown> = {
  bash: createBashToolDefinition,
  read: createReadToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

const userText = (m: any): string =>
  typeof m.content === "string" ? m.content : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");


const isMessage = (e: any) => e?.type === "message" || e?.type === "custom_message";

class Transcript extends Container {
  private readonly saved = new Container();
  private readonly live = new Container();
  private readonly groups = new ToolGroups();
  private readonly copies = new WeakMap<object, unknown>(); // each call's arguments → this transcript's copy
  private last?: string; // id of the last entry drawn
  private tools: ToolExecutionComponent[] = [];
  private pending = new Map<string, ToolExecutionComponent>(); // saved calls without a result
  private rendered = new Map<string, { target: ToolExecutionComponent; message: any }>(); // finished calls, for the refresh above
  private streaming?: { component: AssistantMessageComponent; calls: Map<string, ToolExecutionComponent> };
  private seen = -1;
  private expanded: boolean;
  private readonly hide: boolean;
  private readonly pad: number;
  private readonly source: Source;
  private readonly tui: TUI;
  private readonly ui: ExtensionUIContext;

  constructor(source: Source, tui: TUI, ui: ExtensionUIContext) {
    super();
    this.source = source;
    this.tui = tui;
    this.ui = ui;
    this.addChild(this.saved);
    this.addChild(this.live);
    // Read on each open, so Ctrl+T in the main chat applies from the next open.
    const settings = SettingsManager.create(source.cwd, getAgentDir());
    this.hide = settings.getHideThinkingBlock();
    this.groups.showThinking = !this.hide;
    this.pad = settings.getOutputPad();
    this.expanded = ui.getToolsExpanded();
  }

  /**
   * The message with its own deep copy of each call's arguments: the renderers find a call's
   * groups by that object, so the child session's own groups never answer for this
   * transcript, and later streaming updates never reach what is drawn. One copy per
   * arguments object, so a sync that changed nothing keeps each call's arguments the same.
   */
  private own(m: any) {
    const copy = (a: any) => {
      if (!a || typeof a !== "object") return structuredClone(a ?? {});
      if (!this.copies.has(a)) this.copies.set(a, structuredClone(a));
      return this.copies.get(a);
    };
    return { ...m, content: m.content.map((b: any) => (b?.type === "toolCall" ? { ...b, arguments: copy(b.arguments) } : b)) };
  }

  /** The viewer closed it: its calls leave the process-wide group index. */
  dispose() {
    this.groups.reset();
    this.rendered.clear();
  }

  private tool(call: any, m: any) {
    const src = this.source;
    const definition = src.session?.getToolDefinition(call.name) ?? src.root.defs.get(call.name) ?? BUILT_INS[call.name]?.(src.cwd);
    const c = new ToolExecutionComponent(call.name, call.id, call.arguments, {}, definition as any, this.tui, src.cwd);
    c.setExpanded(this.expanded);
    this.tools.push(c);
    // As Pi's chat does: a call cut off by an abort or error shows the message's error.
    if (m.stopReason === "aborted" || m.stopReason === "error") {
      c.updateResult({ content: [{ type: "text", text: m.stopReason === "aborted" ? "Operation aborted" : m.errorMessage || "Error" }], isError: true });
    }
    return c;
  }

  private add(message: any) {
    // A message drawn between two runs of calls splits them, as in the main chat.
    if (message.role !== "assistant") this.groups.track(message);
    if (message.role === "user") {
      const text = userText(message);
      if (!text) return;
      if (this.saved.children.length) this.saved.addChild(new Spacer(1));
      this.saved.addChild(new UserMessageComponent(text, getMarkdownTheme(), this.pad));
    } else if (message.role === "assistant") {
      const m = this.own(message);
      this.groups.track(m);
      this.saved.addChild(new AssistantMessageComponent(m, this.hide, getMarkdownTheme(), undefined, this.pad));
      for (const call of m.content.filter((b: any) => b?.type === "toolCall")) {
        const c = this.tool(call, m);
        this.saved.addChild(c);
        if (m.stopReason !== "aborted" && m.stopReason !== "error") this.pending.set(call.id, c);
      }
    } else if (message.role === "toolResult") {
      this.groups.settle(message.toolCallId, message.isError, message);
      const target = this.pending.get(message.toolCallId);
      target?.updateResult(message);
      if (target) this.rendered.set(message.toolCallId, { target, message });
      this.pending.delete(message.toolCallId);
    } else if (message.role === "custom" && message.display) {
      // Plain text with control sequences removed: a child's message never styles or moves the parent's screen.
      const text = typeof message.content === "string" ? message.content : userText(message);
      this.saved.addChild(new Spacer(1));
      this.saved.addChild(new Text(this.ui.theme.fg("muted", text.split("\n").map(oneLine).join("\n")), this.pad, 0));
    }
    // ponytail: compaction and branch summaries are not drawn; add Pi's components for them if a summary is wanted on screen.
  }

  /** Draws the entries added since the last sync. The first sync draws the last OPEN_MESSAGES messages. */
  private appendEntries() {
    const m = this.source.manager;
    const leaf = m.getLeafId() ?? undefined;
    if (leaf === this.last) return;
    const up = (id: string) => m.getEntry(id)?.parentId ?? undefined;
    const fresh: any[] = [];
    let messages = 0;
    let id = leaf;
    for (; id && id !== this.last && messages < OPEN_MESSAGES; id = up(id)) {
      const e = m.getEntry(id);
      fresh.push(e);
      if (isMessage(e)) messages++;
    }
    if (id !== this.last) {
      // A first open, a branch switch or a burst past the limit: start over, counting what is left out.
      this.saved.clear();
      this.groups.reset();
      this.tools = [];
      this.pending.clear();
      this.rendered.clear();
      let earlier = 0;
      for (; id; id = up(id)) if (isMessage(m.getEntry(id))) earlier++;
      if (earlier) this.saved.addChild(new Text(this.ui.theme.fg("dim", `… ${earlier} earlier message${earlier === 1 ? "" : "s"}`), 1, 0));
    }
    for (const e of fresh.reverse()) for (const msg of sessionEntryToContextMessages(e)) this.add(msg);
    this.last = leaf;
  }

  /** Brings the components up to date with the agent: new saved messages, the streaming one, pending steers. */
  private sync() {
    const src = this.source;
    const expanded = this.ui.getToolsExpanded();
    if (expanded !== this.expanded) {
      this.expanded = expanded;
      for (const c of this.tools) c.setExpanded(expanded);
    }
    if (src.version === this.seen) return;
    this.seen = src.version;

    this.appendEntries();
    for (const [id, c] of this.pending) {
      const partial = src.partial.get(id);
      if (partial) c.updateResult({ ...(partial as any), isError: partial.isError ?? false }, true);
    }

    this.live.clear();
    const session = src.session;
    const message: any = session?.agent.state.streamingMessage;
    if (message?.role === "assistant") {
      const m = this.own(message);
      this.groups.track(m, true);
      if (!this.streaming) {
        this.streaming = { component: new AssistantMessageComponent(undefined, this.hide, getMarkdownTheme(), undefined, this.pad), calls: new Map() };
      }
      const { component, calls } = this.streaming;
      component.updateContent(m, true);
      this.live.addChild(component);
      for (const call of m.content.filter((b: any) => b?.type === "toolCall")) {
        let c = calls.get(call.id);
        if (c) c.updateArgs(call.arguments);
        else calls.set(call.id, (c = this.tool(call, m)));
        this.live.addChild(c);
      }
    } else if (this.streaming) {
      const gone = new Set(this.streaming.calls.values());
      this.tools = this.tools.filter((c) => !gone.has(c));
      this.streaming = undefined;
    }
    if (!session?.isStreaming) {
      this.groups.endRun();
      // A closed transcript renders once: settle-time rows baked a spinner while the
      // run was open, so refresh every finished call to rest on the dot.
      for (const { target, message } of this.rendered.values()) target.updateResult(message);
    }
    const steers = session?.getSteeringMessages() ?? [];
    if (steers.length) {
      this.live.addChild(new Spacer(1));
      for (const s of steers) this.live.addChild(new Text(this.ui.theme.fg("dim", `Steering: ${oneLine(s)}`), 1, 0));
    }
  }

  override render(width: number) {
    this.sync();
    return super.render(width);
  }
}

/** A new transcript of the agent for the viewer showing it on `tui`. The viewer calls its `dispose()` on close. */
export const transcript = (source: Source, tui: TUI, ui: ExtensionUIContext) => new Transcript(source, tui, ui);
