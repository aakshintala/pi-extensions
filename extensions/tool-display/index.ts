// Tool display (spec #40, ticket #55): gives the built-in read, edit, write and ls
// tools the shared style. Pi keeps built-in definitions out of reach of extensions
// (getAllTools returns copies), so the decoration sits on ToolExecutionComponent's
// renderer lookups, installed once per session and removed on shutdown.
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// One decoration per process, whichever extension instance installed it.
const SAVED = Symbol.for("pi-rig.tool-display.saved");
const METHODS = ["getCallRenderer", "getResultRenderer", "getRenderShell"] as const;
const proto = ToolExecutionComponent.prototype as any;

function undecorate() {
  const saved = proto[SAVED];
  if (!saved) return;
  for (const m of METHODS) proto[m] = saved[m];
  delete proto[SAVED];
}

function decorate(names: Set<string>) {
  undecorate();
  if (!METHODS.every((m) => typeof proto[m] === "function")) return; // Pi changed shape: leave its rendering alone
  const saved: Record<string, Function> = Object.fromEntries(METHODS.map((m) => [m, proto[m]]));
  proto[SAVED] = saved;
  const style = (c: any) => (names.has(c.toolName) ? RENDERERS[c.toolName] : undefined);
  proto.getCallRenderer = function () {
    return style(this)?.renderCall ?? saved.getCallRenderer.call(this);
  };
  proto.getResultRenderer = function () {
    return style(this)?.renderResult ?? saved.getResultRenderer.call(this);
  };
  proto.getRenderShell = function () {
    return style(this)?.renderShell ?? saved.getRenderShell.call(this);
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Only the built-ins: a tool another extension registered under one of these names keeps its own look.
    decorate(new Set(pi.getAllTools().filter((t) => t.sourceInfo?.source === "builtin" && t.name in RENDERERS).map((t) => t.name)));
    // On /resume and fork Pi draws the history before session_start; redraw it decorated.
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("rig-tool-display", (tui) => {
        tui.invalidate();
        tui.requestRender();
        return { render: () => [], invalidate() {} };
      });
      ctx.ui.setWidget("rig-tool-display", undefined);
    }
  });
  pi.on("session_shutdown", undecorate);
}
