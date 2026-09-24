// Tool display (spec #40, ticket #55): the built-in read, edit and write tools,
// built from Pi's own definitions and drawn in the shared style.
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  sessionEntryToContextMessages,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  diffBody,
  EXPANDED_LINES,
  plural,
  resultText,
  shortPath,
  ToolGroups,
  toolRenderers,
  unifiedDiff,
} from "../../shared/tool-display/index.ts";
import { releaseHiddenThinking, useHiddenThinking } from "./thinking.ts";

const textLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** `f(key)`, computed once per key object: Pi rebuilds a call's rows on every change, and its args and result content stay the same objects. */
const once = <V>(f: (key: any) => V) => {
  const seen = new WeakMap<object, V>();
  return (key: any): V => {
    if (!key || typeof key !== "object") return f(key);
    if (!seen.has(key)) seen.set(key, f(key));
    return seen.get(key)!;
  };
};

const contentLines = once((a: any) => textLines(typeof a?.content === "string" ? a.content : ""));
const resultLinesOf = once((content: unknown) => textLines(resultText({ content })));
const diffOf = once((a: any) => unifiedDiff(editPairs(a)));
/** Only the lines an expanded result can show are styled; the rest only count. */
const styled = (lines: string[], style: (l: string) => string) => lines.map((l, i) => (i < EXPANDED_LINES ? style(l) : l));

const editPairs = (args: any): { oldText: string; newText: string }[] =>
  Array.isArray(args?.edits)
    ? args.edits.filter((e: any) => typeof e?.oldText === "string" && typeof e?.newText === "string")
    : typeof args?.oldText === "string" && typeof args?.newText === "string"
      ? [{ oldText: args.oldText, newText: args.newText }]
      : [];

export const RENDERERS: Record<string, ReturnType<typeof toolRenderers>> = {
  read: toolRenderers({
    title: "Read",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    summary: { verb: "read", one: "file" },
    result: (r: any, _a, expanded, theme) => {
      if (Array.isArray(r?.content) && r.content.some((c: any) => c?.type === "image")) return { summary: "Read image", body: [] };
      const body = resultLinesOf(r?.content);
      return { summary: `Read ${body.length} ${plural(body.length, "line")}`, body: expanded ? styled(body, (l) => theme.fg("toolOutput", l)) : [] };
    },
  }),
  edit: toolRenderers({
    title: "Edit",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    summary: { verb: "edited", one: "file", lines: (a) => { const d = diffOf(a); return d.tooLarge ? undefined : d; } },
    result: (r, a, _e, theme) => {
      const pairs = editPairs(a);
      if (pairs.length === 0) return { summary: resultText(r).split("\n")[0] || "Edited", body: [] }; // arguments of an unknown shape
      const diff = diffOf(a);
      if (diff.tooLarge) return { summary: "Edited (diff too large to show)", body: [] };
      const summary = `Added ${diff.added} ${plural(diff.added, "line")}, removed ${diff.removed} ${plural(diff.removed, "line")}`;
      return { summary, body: diffBody(theme, diff) };
    },
  }),
  write: toolRenderers({
    title: "Write",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    summary: { verb: "wrote", one: "file", lines: (a) => ({ added: contentLines(a).length, removed: 0 }) },
    result: (_r, a: any, _e, theme) => {
      const body = contentLines(a);
      return { summary: `Wrote ${body.length} ${plural(body.length, "line")}`, body: styled(body, (l) => theme.fg("toolOutput", l)) };
    },
  }),
};

/** `piVersion` is Pi's own version; tests pass another to exercise the thinking patch's guard. */
export default function (pi: ExtensionAPI, piVersion: string = VERSION) {
  // Execution stays Pi's own (each built-in resolves paths against the call's ctx.cwd);
  // only the renderers change. Registering a built-in's name replaces the built-in.
  // Not ls: Pi activates every registered extension tool, and ls is off by default,
  // so registering it would add prompt tokens. It keeps Pi's look when enabled.
  // read uses the factory's autoResizeImages default: extensions cannot read Pi's setting.
  const cwd = process.cwd();
  for (const def of [createReadToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd)]) {
    pi.registerTool({ ...def, ...RENDERERS[def.name] } as any);
  }

  // Groups (#56, #133) come from the messages in order: live from message events, and
  // from the entries Pi draws (its context entries) at session start, after /tree and
  // after a compaction, so a resumed transcript groups the same way, and calls Pi no
  // longer draws are dropped with the components they hold. Each session (each instance of this extension) has its own groups.
  const groups = new ToolGroups();
  let refresh: ReturnType<typeof setInterval> | undefined;
  const stopRefresh = () => {
    clearInterval(refresh);
    refresh = undefined;
  };
  const load = (branch: any[]) => {
    groups.reset();
    for (const m of branch.flatMap((e) => sessionEntryToContextMessages(e))) {
      if (m?.role === "toolResult") groups.settle(m.toolCallId, m.isError, m);
      else groups.track(m);
    }
    groups.endRun();
  };
  // Hidden thinking (#57): patched while a session with this extension is live, so a
  // /reload that drops the extension, /new and /resume never inherit it.
  pi.on("session_start", (_e, ctx) => {
    groups.owner = ctx.sessionManager.getSessionId(); // how showHint names the session
    useHiddenThinking(groups, piVersion);
    load(ctx.sessionManager.buildContextEntries());
  });
  pi.on("session_tree", (_e, ctx) => load(ctx.sessionManager.buildContextEntries()));
  // Pi emits this before it redraws the chat from its context entries.
  pi.on("session_compact", (_e, ctx) => load(ctx.sessionManager.buildContextEntries()));
  pi.on("message_update", (e) => groups.track(e.message, true));
  pi.on("message_end", (e) => groups.track(e.message));
  pi.on("tool_execution_end", (e) => groups.settle(e.toolCallId, e.isError, e.result));
  pi.on("agent_start", () => {
    // Keep the grace-period reveal and changing hints, without animating tool rows.
    refresh ??= setInterval(() => groups.refreshPending(), 250);
  });
  pi.on("agent_end", () => {
    stopRefresh();
    groups.endRun();
  });
  pi.on("session_shutdown", () => {
    releaseHiddenThinking(groups);
    stopRefresh();
    groups.reset();
  });
}
