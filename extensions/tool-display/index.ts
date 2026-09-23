// Tool display (spec #40, ticket #55): the built-in read, edit, write and ls tools,
// built from Pi's own definitions and drawn in the shared style.
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  diffBody,
  plural,
  resultText,
  shortPath,
  toolRenderers,
  unifiedDiff,
} from "../../shared/tool-display/index.ts";

const textLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

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
    result: (r: any, _a, expanded, theme) => {
      if (r.content.some((c: any) => c.type === "image")) return { summary: "Read image", body: [] };
      const body = textLines(resultText(r));
      return { summary: `Read ${body.length} ${plural(body.length, "line")}`, body: expanded ? body.map((l) => theme.fg("toolOutput", l)) : [] };
    },
  }),
  edit: toolRenderers({
    title: "Edit",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    result: (_r, a, _e, theme) => {
      const diff = unifiedDiff(editPairs(a));
      if (diff.tooLarge) return { summary: "Edited (diff too large to show)", body: [] };
      const summary = `Added ${diff.added} ${plural(diff.added, "line")}, removed ${diff.removed} ${plural(diff.removed, "line")}`;
      return { summary, body: diffBody(theme, diff) };
    },
  }),
  write: toolRenderers({
    title: "Write",
    arg: (a: any, cwd) => shortPath(a.path ?? a.file_path, cwd),
    result: (_r, a: any, _e, theme) => {
      const body = textLines(typeof a.content === "string" ? a.content : "");
      return { summary: `Wrote ${body.length} ${plural(body.length, "line")}`, body: body.map((l) => theme.fg("toolOutput", l)) };
    },
  }),
  ls: toolRenderers({
    title: "List",
    arg: (a: any, cwd) => shortPath(a.path ?? ".", cwd),
    result: (r: any, _a, _e, theme) => {
      const text = resultText(r);
      const body = text.trim() === "(empty directory)" ? [] : textLines(text);
      return { summary: `Listed ${body.length} ${plural(body.length, "entry", "entries")}`, body: body.map((l) => theme.fg("toolOutput", l)) };
    },
  }),
};

export default function (pi: ExtensionAPI) {
  // Execution stays Pi's own (each built-in resolves paths against the call's ctx.cwd);
  // only the renderers change. Registering a built-in's name replaces the built-in.
  const cwd = process.cwd();
  for (const def of [createReadToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd), createLsToolDefinition(cwd)]) {
    pi.registerTool({ ...def, ...RENDERERS[def.name] } as any);
  }
}
