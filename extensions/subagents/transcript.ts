// An agent's transcript for the fleet viewer (#68): its saved session drawn with Pi's
// own message components, tool calls grouped as in the main chat (#56), and followed
// live while the agent runs. It is pull-based: a render after the agent reports a change
// reads its saved entries and its session's streaming message, so an unseen transcript
// holds no listener and needs no disposal. Each agent keeps one transcript, reused by
// every open.
// ponytail: its ToolGroups stay indexed for the process; reset them if long runs view many agents.
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomMessageComponent,
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

/** What a transcript reads from an agent. */
export interface Source {
  manager: SessionManager;
  cwd: string;
  session?: AgentSession;
  /** Tool definitions of its last session, for drawing calls once it is gone. */
  tools?: Map<string, unknown>;
  /** Partial results of running calls, by call id. */
  partial: Map<string, unknown>;
  /** Bumped on every session event. */
  version: number;
  view?: Transcript;
}

/** Built-ins, for a transcript whose agent has not run in this process. */
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

/**
 * The message with its own copy of each call's arguments: the renderers find a call's
 * groups by that object, so the child session's own groups never answer for this transcript.
 */
const own = (m: any) => ({
  ...m,
  content: m.content.map((b: any) => (b?.type === "toolCall" ? { ...b, arguments: { ...b.arguments } } : b)),
});

class Transcript extends Container {
  private readonly saved = new Container();
  private readonly live = new Container();
  private readonly groups = new ToolGroups();
  private shown: unknown[] = []; // saved entries drawn, in order
  private tools: ToolExecutionComponent[] = [];
  private pending = new Map<string, ToolExecutionComponent>(); // saved calls without a result
  private streaming?: { component: AssistantMessageComponent; calls: Map<string, ToolExecutionComponent> };
  private seen = -1;
  private expanded: boolean;
  private readonly hide: boolean;
  private readonly pad: number;

  private tui!: TUI;
  private ui!: ExtensionUIContext;
  private readonly source: Source;

  constructor(source: Source) {
    super();
    this.source = source;
    this.addChild(this.saved);
    this.addChild(this.live);
    const settings = SettingsManager.create(source.cwd, getAgentDir());
    // ponytail: read once; Ctrl+T while viewing applies when the transcript is reopened.
    this.hide = settings.getHideThinkingBlock();
    this.pad = settings.getOutputPad();
    this.expanded = false;
  }

  /** The viewer that shows it now. */
  use(tui: TUI, ui: ExtensionUIContext) {
    this.tui = tui;
    this.ui = ui;
    return this;
  }

  private tool(call: any, m: any) {
    const src = this.source;
    const definition = src.session?.getToolDefinition(call.name) ?? src.tools?.get(call.name) ?? BUILT_INS[call.name]?.(src.cwd);
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
    if (message.role === "user") {
      const text = userText(message);
      if (!text) return;
      if (this.saved.children.length) this.saved.addChild(new Spacer(1));
      this.saved.addChild(new UserMessageComponent(text, getMarkdownTheme(), this.pad));
    } else if (message.role === "assistant") {
      const m = own(message);
      this.groups.track(m);
      this.saved.addChild(new AssistantMessageComponent(m, this.hide, getMarkdownTheme(), undefined, this.pad));
      for (const call of m.content.filter((b: any) => b?.type === "toolCall")) {
        const c = this.tool(call, m);
        this.saved.addChild(c);
        if (m.stopReason !== "aborted" && m.stopReason !== "error") this.pending.set(call.id, c);
      }
    } else if (message.role === "toolResult") {
      this.groups.settle(message.toolCallId, message.isError, message);
      this.pending.get(message.toolCallId)?.updateResult(message);
      this.pending.delete(message.toolCallId);
    } else if (message.role === "custom" && message.display) {
      const renderer = this.source.session?.extensionRunner.getMessageRenderer(message.customType);
      this.saved.addChild(new CustomMessageComponent(message, renderer, getMarkdownTheme(), this.pad));
    }
    // ponytail: compaction and branch summaries are not drawn; add Pi's components for them if children compact.
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

    const entries = src.manager.buildContextEntries();
    if (this.shown.some((e, i) => entries[i] !== e)) {
      // Rewritten history (a compaction): draw it again.
      this.saved.clear();
      this.groups.reset();
      this.shown = [];
      this.tools = [];
      this.pending.clear();
    }
    for (const e of entries.slice(this.shown.length)) for (const m of sessionEntryToContextMessages(e)) this.add(m);
    this.shown = entries;
    for (const [id, c] of this.pending) {
      const partial = src.partial.get(id);
      if (partial) c.updateResult({ ...(partial as any), isError: false }, true);
    }

    this.live.clear();
    const session = src.session;
    const message: any = session?.agent.state.streamingMessage;
    if (message?.role === "assistant") {
      const m = own(message);
      this.groups.track(m);
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
      this.tools = this.tools.filter((c) => ![...this.streaming!.calls.values()].includes(c));
      this.streaming = undefined;
    }
    if (!session?.isStreaming) this.groups.endRun();
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

/** The agent's transcript, for the viewer showing it on `tui`. */
export const transcript = (source: Source, tui: TUI, ui: ExtensionUIContext) => (source.view ??= new Transcript(source)).use(tui, ui);
