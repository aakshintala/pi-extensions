// Inline skills (spec #36): `/skill-name` anywhere in a prompt loads that skill
// for the turn, with mid-line `/` autocomplete. Ported from @tifan/pi-inline-skills
// 1.0.6 (MIT, upstream/pi-inline-skills/).
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ParsedSkillBlock,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  stripFrontmatter,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// Same type as upstream, so skills loaded by it before the port still count as loaded.
const MESSAGE_TYPE = "inline-skill";
const MAX_ITEMS = 30;
// A `/name` token starts the text or follows whitespace or one of `([{,`, both when
// a message is sent and while one is typed; a token with a second `/` never matches.
const BOUNDARY = String.raw`(?:^|[\s([{,])`;
// When sent: not followed by `:` or `/`.
const TOKEN = new RegExp(String.raw`${BOUNDARY}\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])`, "gi");
// While typed: the `/word` before the cursor.
const TYPING = new RegExp(String.raw`${BOUNDARY}\/([a-z0-9-]*)$`, "i");

export type Skill = { name: string; description?: string; path: string };
type Item = { value: string; label: string; description?: string };
type Lines = string[];

function listSkills(pi: ExtensionAPI): Skill[] {
  return pi
    .getCommands()
    .filter((c) => c.source === "skill" && c.name.startsWith("skill:") && c.sourceInfo?.path)
    .map((c) => ({ name: c.name.slice(6), description: c.description, path: c.sourceInfo.path }));
}

/** Skills named in `text` that are not in `loaded`. `skills` is only called when the text has a `/`. */
export function namedSkills(text: string, skills: () => Skill[], loaded: Set<string>, commands: () => string[] = () => []): Skill[] {
  if (!text.includes("/")) return [];
  const start = /^\/([a-z0-9][a-z0-9-]*)/i.exec(text)?.[1]?.toLowerCase();
  const byName = new Map(skills().map((s) => [s.name.toLowerCase(), s]));
  const out = new Map<string, Skill>();
  for (const m of text.matchAll(TOKEN)) {
    const skill = byName.get(m[1].toLowerCase());
    // A registered command wins at the start of the prompt.
    if (m.index === 0 && start && commands().includes(start)) continue;
    if (skill && !loaded.has(skill.name)) out.set(skill.name, skill);
  }
  return [...out.values()];
}

// Body goes in a backtick fence longer than any backtick run inside it, so no body can close it.
function fence(body: string): string {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const f = "`".repeat(longest + 1);
  return `${f}markdown\n${body}\n${f}`;
}

async function readSkill(skill: Skill): Promise<ParsedSkillBlock> {
  const body = stripFrontmatter(await readFile(skill.path, "utf8")).trim();
  return { name: skill.name, location: skill.path, content: body, userMessage: undefined };
}

const HEADER = "Skills the user named in this request, loaded in full. Follow them for it; read a skill's file only to inspect its source.";

function skillText(blocks: ParsedSkillBlock[]): string {
  const parts = blocks.map(
    (b) => `Skill \`${b.name}\` (${b.location}). Its relative paths start at ${dirname(b.location)}.\n${fence(b.content)}`,
  );
  return `${HEADER}\n\n${parts.join("\n\n")}`;
}

/** The custom message that follows a prompt naming skills. */
export function skillMessage(blocks: ParsedSkillBlock[]) {
  return {
    customType: MESSAGE_TYPE,
    content: skillText(blocks),
    display: true,
    details: { names: blocks.map((b) => b.name), skills: blocks },
  };
}

/**
 * A steer or follow-up carries its skills in its own text, in the block form Pi uses
 * for `/skill:name`, so they arrive in the same message: queued messages are
 * delivered one per turn by default, so a separate message would arrive a turn early.
 */
function withSkills(message: any, blocks: ParsedSkillBlock[]) {
  const block = `<skill name="${blocks.map((b) => b.name).join(", ")}" location="${blocks[0].location}">\n${skillText(blocks)}\n</skill>`;
  const text = textOf(message);
  const rest = typeof message.content === "string" ? [] : message.content.filter((c: any) => c.type !== "text");
  return { ...message, content: [{ type: "text", text: `${block}\n\n${text}` }, ...rest] };
}

const textOf = (message: any): string =>
  typeof message.content === "string" ? message.content : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

/**
 * The names of the leading skill blocks, Pi's own (`/skill:name`) or ours, and the text
 * after them; no text when a block does not parse.
 */
function leadingBlocks(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  for (let b; (b = parseSkillBlock(text)); text = b.userMessage ?? "") names.push(...b.name.split(/,\s*/));
  return { names, rest: /^<skill name="[^"]+"/.test(text) ? "" : text };
}

function restoreLoaded(ctx: ExtensionContext): Set<string> {
  const loaded = new Set<string>();
  for (const e of ctx.sessionManager.getBranch() as any[]) {
    if (e.type === "custom_message" && e.customType === MESSAGE_TYPE) {
      for (const s of e.details?.skills ?? []) if (s?.name) loaded.add(s.name);
    } else if (e.type === "custom" && e.customType === "loaded-skill" && typeof e.data?.name === "string") {
      loaded.add(e.data.name); // written by upstream when the agent read a skill file
    } else if (e.type === "message" && e.message?.role === "user") {
      for (const name of leadingBlocks(textOf(e.message)).names) loaded.add(name);
    }
  }
  return loaded;
}

/** The `/word` query at the cursor, when it is not at the start of the message. */
function midLineQuery(lines: Lines, line: number, col: number): string | undefined {
  const before = (lines[line] ?? "").slice(0, col);
  const m = TYPING.exec(before);
  if (!m) return undefined;
  return line > 0 || /\S/.test(before.slice(0, before.length - m[1].length - 1)) ? m[1] : undefined;
}

export function skillProvider(skills: () => Skill[], current: any) {
  const ours = new WeakSet<Item>();
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines: Lines, line: number, col: number, options: any) {
      const query = midLineQuery(lines, line, col);
      if (query === undefined) return current.getSuggestions(lines, line, col, options);
      // Owned: never fall through to file completion, which reads `/sk` as an absolute path.
      const q = query.toLowerCase();
      const items = skills()
        .filter((s) => s.name.includes(q))
        .sort((a, b) => +!a.name.startsWith(q) - +!b.name.startsWith(q) || a.name.localeCompare(b.name))
        .slice(0, MAX_ITEMS)
        .map((s) => {
          const item: Item = { value: `/${s.name}`, label: s.name, description: s.description };
          ours.add(item);
          return item;
        });
      // Prefix without the `/`, so Enter accepts the item instead of submitting.
      return items.length ? { items, prefix: query } : null;
    },
    applyCompletion(lines: Lines, line: number, col: number, item: Item, prefix: string) {
      if (!ours.has(item)) return current.applyCompletion(lines, line, col, item, prefix);
      const text = lines[line] ?? "";
      const start = col - prefix.length - 1;
      const after = text.slice(col);
      const sp = after.startsWith(" ") ? "" : " ";
      const next = [...lines];
      next[line] = text.slice(0, start) + item.value + sp + after;
      return { lines: next, cursorLine: line, cursorCol: start + item.value.length + sp.length };
    },
    shouldTriggerFileCompletion: (lines: Lines, line: number, col: number) =>
      current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
  };
}

// Marks an editor wrapped by a live install, so two installs never stack.
const INSTALL = Symbol.for("pi-rig.inline-skills.install");

/**
 * Pi's main editor: the default editor or one set by setEditorComponent. Pi gives
 * either its app actions; a CustomEditor mounted by ui.custom() has none.
 */
function isMainEditor(editor: any, version: string): boolean {
  return (
    version.startsWith("0.87.") &&
    editor instanceof CustomEditor &&
    typeof (editor as any).tryTriggerAutocomplete === "function" &&
    typeof (editor as any).isShowingAutocomplete === "function" &&
    Array.isArray((editor as any).state?.lines) &&
    (editor as any).actionHandlers?.has?.("app.clear") === true
  );
}

/**
 * Guarded Pi patch (#1): wraps the handleInput of Pi's main editor instance so a
 * mid-message `/` plus two name characters opens the list. Pi's editor refuses `/`
 * as a provider trigger character and opens the list on typed letters only when
 * the message starts with `/`. `ensure` wraps whatever main editor sits in Pi's
 * editor slot now (moving the wrap when the editor was replaced) and skips any
 * mismatch, leaving Tab-only completion; `restore` undoes it.
 */
export function editorPatch(version = VERSION) {
  let target: any;
  let original: any;
  let hadOwn = false;
  const token = {};
  const wrapped = function (this: any, data: string) {
    original.call(this, data);
    if (this.isShowingAutocomplete() || !/^[a-z0-9-]$/i.test(data)) return;
    const { lines, cursorLine, cursorCol } = this.state;
    if ((midLineQuery(lines, cursorLine, cursorCol)?.length ?? 0) >= 2) this.tryTriggerAutocomplete();
  };
  const restore = () => {
    if (target?.[INSTALL] === token && target.handleInput === wrapped) {
      if (hadOwn) target.handleInput = original;
      else delete target.handleInput;
      delete target[INSTALL];
    }
    target = undefined;
  };
  const ensure = (tui: any): boolean => {
    const editor = tui?.children?.[4]?.children?.[0];
    if (editor && editor === target) return true;
    if (!isMainEditor(editor, version) || editor[INSTALL]) return false;
    restore();
    hadOwn = Object.hasOwn(editor, "handleInput");
    original = editor.handleInput;
    editor.handleInput = wrapped;
    editor[INSTALL] = token;
    target = editor;
    return true;
  };
  return { ensure, restore };
}

export default function (pi: ExtensionAPI) {
  let loaded = new Set<string>();
  // Named by the prompt being started; loaded once its message is delivered.
  let starting = new Set<string>();
  const patch = editorPatch();
  let unsubscribe: (() => void) | undefined;
  const skills = () => listSkills(pi);
  const commands = () => pi.getCommands().filter((c) => c.source !== "skill").map((c) => c.name.toLowerCase());
  const toLoad = (text: string, { names, rest } = leadingBlocks(text)) => {
    // After a leading block the text is no longer the start of the prompt, so commands do not win there.
    return namedSkills(rest, skills, new Set([...loaded, ...starting, ...names]), rest === text ? commands : undefined);
  };

  async function read(named: Skill[], ctx: ExtensionContext): Promise<ParsedSkillBlock[]> {
    const results = await Promise.allSettled(named.map(readSkill));
    const failed = named.filter((_, i) => results[i].status === "rejected").map((s) => s.name);
    if (failed.length) ctx.ui.notify(`inline-skills: could not read ${failed.join(", ")}`, "error");
    return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }) => {
    const blocks = (message.details as { skills?: ParsedSkillBlock[] } | undefined)?.skills;
    if (!blocks?.length) return undefined;
    const box = new Container();
    for (const block of blocks) {
      const c = new SkillInvocationMessageComponent(block);
      c.setExpanded(expanded);
      box.addChild(c);
    }
    return box;
  });

  pi.on("session_start", (_e, ctx) => {
    loaded = restoreLoaded(ctx);
    starting = new Set();
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => skillProvider(skills, current));
    // The widget factory is called synchronously with Pi's TUI; drop the widget at once.
    let tui: any;
    ctx.ui.setWidget("inline-skills", (t) => {
      tui = t;
      return new Container();
    });
    ctx.ui.setWidget("inline-skills", undefined);
    // Pi's editor slot changes: /reload shows a notice there during session_start,
    // setEditorComponent swaps editors, panels take it over. Check again on each key.
    patch.ensure(tui);
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput(() => void patch.ensure(tui));
  });

  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    patch.restore();
  });

  pi.on("session_tree", (_e, ctx) => {
    loaded = restoreLoaded(ctx);
  });

  // A prompt: its skills follow it as one custom message. Runs after Pi accepted the
  // prompt (model and auth checked); the text is already expanded.
  pi.on("before_agent_start", async (event, ctx) => {
    starting = new Set();
    const named = toLoad(event.prompt);
    if (!named.length) return;
    starting = new Set(named.map((s) => s.name)); // the prompt's own text is not scanned again
    const blocks = await read(named, ctx);
    return blocks.length ? { message: skillMessage(blocks) } : undefined;
  });

  // Delivery. A skill counts as loaded only once its message is delivered. A steer or
  // follow-up (from Pi or the queue) is delivered here, so its skills join its text.
  pi.on("message_end", async (event, ctx) => {
    const message: any = event.message;
    if (message.role === "custom" && message.customType === MESSAGE_TYPE) {
      for (const s of message.details?.skills ?? []) {
        starting.delete(s.name);
        loaded.add(s.name);
      }
      return;
    }
    if (message.role !== "user") return;
    const text = textOf(message);
    const leading = leadingBlocks(text);
    for (const name of leading.names) loaded.add(name);
    const named = toLoad(text, leading);
    if (!named.length) return;
    const blocks = await read(named, ctx);
    if (!blocks.length) return;
    for (const b of blocks) loaded.add(b.name);
    return { message: withSkills(message, blocks) };
  });
}
