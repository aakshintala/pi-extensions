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
  SkillInvocationMessageComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// Same type as upstream, so skills loaded by it before the port still count as loaded.
export const MESSAGE_TYPE = "inline-skill";
const MAX_ITEMS = 30;
// A `/name` token in a submitted prompt: after a boundary, not followed by `:` or `/`.
const TOKEN = /(^|[\s([{,])\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])/gi;
// The `/word` being typed at the cursor; a token with a second `/` never matches.
const TYPING = /(?:^|\s)\/([\w-]*)$/;

export type Skill = { name: string; description?: string; path: string };
type Item = { value: string; label: string; description?: string };
type Lines = string[];

export function listSkills(pi: ExtensionAPI): Skill[] {
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
    const skill = byName.get(m[2].toLowerCase());
    // A registered command wins at the start of the prompt.
    if (m.index === 0 && start && commands().includes(start)) continue;
    if (skill && !loaded.has(skill.name)) out.set(skill.name, skill);
  }
  return [...out.values()];
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const rest = content.slice(end + 4); // the closing `---` may have the body on its line
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

// Body goes in a backtick fence longer than any backtick run inside it, so no body can close it.
function fence(body: string): string {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const f = "`".repeat(longest + 1);
  return `${f}markdown\n${body}\n${f}`;
}

export async function readSkill(skill: Skill): Promise<ParsedSkillBlock> {
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
export function withSkills(message: any, blocks: ParsedSkillBlock[]) {
  const block = `<skill name="${blocks.map((b) => b.name).join(", ")}" location="${blocks[0].location}">\n${skillText(blocks)}\n</skill>`;
  const text = textOf(message);
  const rest = typeof message.content === "string" ? [] : message.content.filter((c: any) => c.type !== "text");
  return { ...message, content: [{ type: "text", text: `${block}\n\n${text}` }, ...rest] };
}

const textOf = (message: any): string =>
  typeof message.content === "string" ? message.content : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

/** Names of a leading skill block, Pi's own (`/skill:name`) or ours. */
const blockNames = (text: string) => /^<skill name="([^"]+)"/.exec(text)?.[1].split(", ");

function restoreLoaded(ctx: ExtensionContext): Set<string> {
  const loaded = new Set<string>();
  for (const e of ctx.sessionManager.getBranch() as any[]) {
    if (e.type === "custom_message" && e.customType === MESSAGE_TYPE) {
      for (const s of e.details?.skills ?? []) if (s?.name) loaded.add(s.name);
    } else if (e.type === "custom" && e.customType === "loaded-skill" && typeof e.data?.name === "string") {
      loaded.add(e.data.name); // written by upstream when the agent read a skill file
    } else if (e.type === "message" && e.message?.role === "user") {
      for (const name of blockNames(textOf(e.message)) ?? []) loaded.add(name);
    }
  }
  return loaded;
}

/** The `/word` query at the cursor, when it is not at the start of the message. */
function midLineQuery(lines: Lines, line: number, col: number): string | undefined {
  const before = (lines[line] ?? "").slice(0, col);
  const m = TYPING.exec(before);
  if (!m) return undefined;
  return line > 0 || /\S/.test(before.slice(0, m.index)) ? m[1] : undefined;
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

const PATCHED = Symbol.for("pi-rig.inline-skills.patched");

/**
 * Guarded Pi patch (#1): wraps Pi's main editor instance so a mid-line `/` plus two
 * word characters opens the list. Pi's editor refuses `/` as a provider trigger
 * character and opens the list on typed letters only when the message starts with `/`.
 * Returns whether the editor is patched; any mismatch leaves Tab-only completion.
 */
export function patchEditor(tui: any, version = VERSION): boolean {
  const editor = tui?.children?.[4]?.children?.[0];
  if (
    !version.startsWith("0.87.") ||
    !(editor instanceof CustomEditor) ||
    typeof (editor as any).tryTriggerAutocomplete !== "function" ||
    typeof (editor as any).isShowingAutocomplete !== "function" ||
    !Array.isArray((editor as any).state?.lines)
  )
    return false;
  const e = editor as any;
  if (e[PATCHED]) return true;
  const handleInput = e.handleInput;
  e.handleInput = function (data: string) {
    handleInput.call(this, data);
    if (e.isShowingAutocomplete() || !/^[\w-]$/.test(data)) return;
    const { lines, cursorLine, cursorCol } = e.state;
    if ((midLineQuery(lines, cursorLine, cursorCol)?.length ?? 0) >= 2) e.tryTriggerAutocomplete();
  };
  e[PATCHED] = true;
  return true;
}

export default function (pi: ExtensionAPI) {
  let loaded = new Set<string>();
  // Named by the prompt being started; loaded once its message is delivered.
  let starting = new Set<string>();
  const skills = () => listSkills(pi);
  const commands = () => pi.getCommands().filter((c) => c.source !== "skill").map((c) => c.name.toLowerCase());
  const toLoad = (text: string) => (blockNames(text) ? [] : namedSkills(text, skills, new Set([...loaded, ...starting]), commands));

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
    ctx.ui.setWidget("inline-skills", (tui) => {
      patchEditor(tui);
      return new Container();
    });
    ctx.ui.setWidget("inline-skills", undefined);
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
    const named = toLoad(text);
    for (const name of blockNames(text) ?? []) loaded.add(name);
    if (!named.length) return;
    const blocks = await read(named, ctx);
    if (!blocks.length) return;
    for (const b of blocks) loaded.add(b.name);
    return { message: withSkills(message, blocks) };
  });
}
