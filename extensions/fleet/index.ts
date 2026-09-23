// FleetView (spec #29, #44): the list of background work below the editor.
// Items come from the shared registry (shared/fleet); this extension is the
// only one that draws them.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, MouseRegion, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { fleet, isFinished, type Item } from "../../shared/fleet/index.ts";

/** Most lines FleetView takes, including the "… N more" line. */
const MAX_LINES = 6;
const MAIN = "main";

type Row = { item?: Item; depth: number };

/** Main session first, then every item with children under their parent. */
function rows(items: readonly Item[]): Row[] {
  const ids = new Set(items.map((i) => i.id));
  const out: Row[] = [{ depth: 0 }];
  const add = (parent: string | undefined, depth: number) => {
    for (const item of items) {
      const p = item.parentId && ids.has(item.parentId) && item.parentId !== item.id ? item.parentId : undefined;
      if (p !== parent) continue;
      out.push({ item, depth });
      add(item.id, depth + 1);
    }
  };
  add(undefined, 0);
  // Items in a parent cycle have no root; show them at the top level.
  for (const item of items) if (!out.some((r) => r.item === item)) out.push({ item, depth: 0 });
  return out;
}

// CSI, OSC, DCS/SOS/PM/APC strings, then any other escape pair.
const SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[\s\S]?/g;

/** One line of plain text: terminal sequences and control characters removed. */
const clean = (s: string) =>
  String(s ?? "")
    .replace(SEQUENCE, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim();

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export default function (pi: ExtensionAPI) {
  let cleanup: (() => void) | undefined;

  pi.on("input", (event) => {
    if (event.source !== "extension") fleet().prune();
  });

  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    if (ctx.mode === "tui") cleanup = mount(ctx);
  });

  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
  });
}

function mount(ctx: ExtensionContext): () => void {
  const registry = fleet();
  let tui: TUI | undefined;
  let focused = false;
  let selected = 0;
  let top = 0; // first row shown
  let timer: ReturnType<typeof setInterval> | undefined;
  const active = MAIN; // the item in the chat area; the viewer (#45) changes it

  const current = () => rows(registry.items());

  // Rows shown, as indices into current(), plus the hidden count.
  function window(all: Row[]) {
    selected = Math.min(selected, all.length - 1);
    if (all.length <= MAX_LINES) return { start: 0, end: all.length, hidden: 0 };
    const size = MAX_LINES - 1;
    top = Math.max(0, Math.min(Math.max(top, selected - size + 1), selected, all.length - size));
    return { start: top, end: top + size, hidden: all.length - size };
  }

  function line(row: Row, index: number, theme: Theme) {
    const id = row.item?.id ?? MAIN;
    const mark = (focused && index === selected ? "›" : " ") + (id === active ? "●" : " ");
    if (!row.item) return theme.fg("accent", mark) + " main";
    const item = row.item;
    const done = isFinished(item.status);
    const state =
      item.status === "queued"
        ? "queued"
        : (done ? (item.status === "completed" ? "done " : `${item.status} `) : "") +
          duration((item.endedAt ?? registry.now()) - item.startedAt);
    const activity = clean(done && item.result !== undefined ? item.result : item.activity());
    const text = `${"  ".repeat(row.depth)}${item.kind} ${clean(item.label)} · ${state}${activity ? ` · ${activity}` : ""}`;
    const color = item.status === "failed" ? "error" : done ? "muted" : "text";
    return theme.fg("accent", mark) + " " + theme.fg(color, text);
  }

  const view = {
    render(width: number) {
      const all = current();
      if (all.length === 1) return [];
      const theme = ctx.ui.theme;
      const { start, end, hidden } = window(all);
      const out = all.slice(start, end).map((row, i) => line(row, start + i, theme));
      if (hidden) out.push(theme.fg("dim", `   … ${hidden} more`));
      return out.map((l) => truncateToWidth(l, width));
    },
    invalidate() {},
  };
  const region = new MouseRegion(view, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const all = current();
    const { start, end } = window(all);
    const index = start + event.y;
    if (index >= end) return undefined;
    focused = true;
    selected = index;
    return { handled: true, render: true };
  });

  const redraw = () => {
    const running = registry.items().some((i) => !isFinished(i.status));
    if (running && !timer) timer = setInterval(() => tui?.requestRender(), 1000);
    if (!running && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (current().length === 1) focused = false;
    tui?.requestRender();
  };
  const unsubscribe = registry.subscribe(redraw);

  const unlisten = ctx.ui.onTerminalInput((data) => {
    if (data.startsWith("\x1b[<") || isKeyRelease(data) || current().length === 1) return undefined;
    if (!focused) {
      if (!(matchesKey(data, "down") || matchesKey(data, "left")) || ctx.ui.getEditorText() !== "") return undefined;
      focused = true;
      selected = 0;
    } else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
    else if (matchesKey(data, "down")) selected = Math.min(current().length - 1, selected + 1);
    else if (matchesKey(data, "escape")) focused = false;
    else {
      focused = false; // any other key goes back to the editor
      tui?.requestRender();
      return undefined;
    }
    tui?.requestRender();
    return { consume: true };
  });

  ctx.ui.setWidget(
    "fleet",
    (t) => {
      tui = t;
      return region;
    },
    { placement: "belowEditor" },
  );
  redraw();

  let done = false;
  return () => {
    if (done) return;
    done = true;
    unsubscribe();
    unlisten();
    if (timer) clearInterval(timer);
    timer = undefined;
    tui = undefined;
  };
}
