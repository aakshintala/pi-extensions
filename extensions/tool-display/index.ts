// Tool display (spec #40, ticket #55): the built-in read, edit and write tools,
// built from Pi's own definitions and drawn in the shared style.
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  diffBody,
  endRun,
  plural,
  resetGroups,
  resultText,
  settle,
  shortPath,
  toolRenderers,
  trackMessage,
  unifiedDiff,
} from "../../shared/tool-display/index.ts";

const textLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

const contentLines = (a: any) => textLines(typeof a?.content === "string" ? a.content : "");

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
    summary: { tool: "read", verb: "read", one: "file" },
    result: (r: any, _a, expanded, theme) => {
      if (Array.isArray(r?.content) && r.content.some((c: any) => c?.type === "image")) return { summary: "Read image", body: [] };
      const body = textLines(resultText(r));
      return { summary: `Read ${body.length} ${plural(body.length, "line")}`, body: expanded ? body.map((l) => theme.fg("toolOutput", l)) : [] };
    },
  }),
  edit: toolRenderers({
    title: "Edit",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    summary: { tool: "edit", verb: "edited", one: "file", lines: (a) => { const d = unifiedDiff(editPairs(a)); return d.tooLarge ? undefined : d; } },
    result: (r, a, _e, theme) => {
      const pairs = editPairs(a);
      if (pairs.length === 0) return { summary: resultText(r).split("\n")[0] || "Edited", body: [] }; // arguments of an unknown shape
      const diff = unifiedDiff(pairs);
      if (diff.tooLarge) return { summary: "Edited (diff too large to show)", body: [] };
      const summary = `Added ${diff.added} ${plural(diff.added, "line")}, removed ${diff.removed} ${plural(diff.removed, "line")}`;
      return { summary, body: diffBody(theme, diff) };
    },
  }),
  write: toolRenderers({
    title: "Write",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    summary: { tool: "write", verb: "wrote", one: "file", lines: (a) => ({ added: contentLines(a).length, removed: 0 }) },
    result: (_r, a: any, _e, theme) => {
      const body = contentLines(a);
      return { summary: `Wrote ${body.length} ${plural(body.length, "line")}`, body: body.map((l) => theme.fg("toolOutput", l)) };
    },
  }),
};

export default function (pi: ExtensionAPI) {
  // Execution stays Pi's own (each built-in resolves paths against the call's ctx.cwd);
  // only the renderers change. Registering a built-in's name replaces the built-in.
  // Not ls: Pi activates every registered extension tool, and ls is off by default,
  // so registering it would add prompt tokens. It keeps Pi's look when enabled.
  // read uses the factory's autoResizeImages default: extensions cannot read Pi's setting.
  const cwd = process.cwd();
  for (const def of [createReadToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd)]) {
    pi.registerTool({ ...def, ...RENDERERS[def.name] } as any);
  }

  // Groups (#56) come from assistant messages: live from message events, and from the
  // saved branch at session start so a resumed transcript groups the same way.
  pi.on("session_start", (_e, ctx) => {
    resetGroups();
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      const m = entry.type === "message" ? entry.message : undefined;
      if (m?.role === "toolResult") settle(m.toolCallId, m.isError ? "error" : "done");
      else trackMessage(m);
    }
    endRun();
  });
  pi.on("message_update", (e) => trackMessage(e.message));
  pi.on("message_end", (e) => trackMessage(e.message));
  // Pi reports no cancelled flag: an error after the turn was aborted is a cancel.
  pi.on("tool_execution_end", (e, ctx) => settle(e.toolCallId, !e.isError ? "done" : ctx.signal?.aborted ? "cancelled" : "error"));
  pi.on("agent_end", () => endRun());
  pi.on("session_shutdown", () => resetGroups());
}
