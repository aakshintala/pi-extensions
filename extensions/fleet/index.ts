// FleetView (spec #29, #44): the list of background work below the editor.
// Items come from the shared registry (shared/fleet); this extension is the
// only one that draws them. It also delivers the session's notices (#46) and
// keeps a run without the UI alive until the work it started returns.
import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, MouseRegion, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { fleet, isFinished, type Item, type Notice } from "../../shared/fleet/index.ts";

/** Most lines FleetView takes, including the "… N more" line. */
const MAX_LINES = 6;
const MAIN = "main";
const NOTICE = "rig.notice";

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

// CSI (7- and 8-bit); OSC, DCS, SOS, PM and APC strings (7- and 8-bit), ended by
// BEL, ST (ESC \\ or 0x9c) or the end of the text; then any other escape pair.
const SEQUENCE =
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[\s\S]?/g;

/** One line of plain text: terminal sequences and control characters removed. */
const clean = (s: string) =>
  String(s ?? "")
    .replace(SEQUENCE, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim();

/** A producer's activity line; a producer that throws breaks only its own row. */
function safeActivity(item: Item) {
  try {
    return item.activity();
  } catch {
    return "activity failed";
  }
}

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const ICON = { completed: ["success", "✓"], failed: ["error", "✗"], stopped: ["warning", "■"] } as const;

/** One themed line per notice; a failed or stopped item's error follows in full. */
const renderNotice: MessageRenderer = (message, { outputPad }, theme) => {
  const item = message.details as Notice["item"] | undefined;
  const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
  if (!item) return new Text(theme.fg("muted", content), outputPad, 0);
  const [color, icon] = isFinished(item.status) ? ICON[item.status as keyof typeof ICON] : (["accent", "●"] as const);
  const state = isFinished(item.status) ? (item.status === "completed" ? "done " : `${item.status} `) : "";
  const head = `${theme.fg(color, icon)} ${clean(item.kind)} ${clean(item.label)} · ${state}${duration(item.ms)}`;
  const body = isFinished(item.status) ? item.result ?? "" : content;
  if (item.status === "failed" || item.status === "stopped") {
    const lines = body.split("\n").map(clean).filter(Boolean);
    return new Text([head, ...lines.map((l) => "  " + theme.fg(color, l))].join("\n"), outputPad, 0);
  }
  const first = clean(body.split("\n")[0] ?? "");
  return new Text(head + (first ? theme.fg("muted", ` · ${first}`) : ""), outputPad, 0);
};

/** The one message a run without the UI gets when it ends with work running. */
function listing(items: Item[], now: number) {
  const rows = items.map((i) => `- ${i.kind} ${i.label} (id ${i.id}): ${i.status}, ${duration(now - i.startedAt)}`);
  return [
    "Your run is ending with work still running:",
    ...rows,
    "Stop what you no longer need. The session stays open until the rest finishes, and each result arrives as a notice.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  let cleanup: (() => void) | undefined;
  let detach: (() => void) | undefined;
  let wake: (() => void) | undefined; // ends a session-end wait
  let listed = false; // this run's end already listed its running work

  pi.registerMessageRenderer(NOTICE, renderNotice);

  pi.on("input", (event) => {
    if (event.source !== "extension") fleet().prune();
  });

  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    detach?.();
    if (ctx.mode === "tui") cleanup = mount(ctx);
    // Idle: starts a turn. Mid-turn (and at settle): steers into it, so notices arriving together share one turn.
    detach = fleet().attach(ctx.sessionManager.getSessionId(), (notice) => {
      pi.sendMessage({ customType: NOTICE, content: notice.text, display: true, details: notice.item }, { triggerTurn: true, deliverAs: "steer" });
      wake?.();
    });
  });

  pi.on("agent_settled", () => {
    listed = false;
  });

  // Session end without the UI (#29): list running work once, then wait for each notice until none is left.
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (ctx.hasUI) return;
    const registry = fleet();
    const owner = ctx.sessionManager.getSessionId();
    const running = () => registry.items().filter((i) => i.owner === owner && !isFinished(i.status));
    if (running().length === 0) return;
    if (!listed) {
      listed = true;
      const content = listing(running(), registry.now());
      return { entries: [{ type: "custom_message", customType: NOTICE, content, display: true }], continue: true };
    }
    // No cap on the wait (spec #29): the command, shell timeout or caller's kill bounds it.
    await new Promise<void>((resolve) => {
      const unsubscribe = registry.subscribe(() => running().length === 0 && wake?.());
      wake = () => {
        unsubscribe();
        wake = undefined;
        resolve();
      };
    });
    return undefined; // a delivered notice is queued, so the session continues
  });

  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
    detach?.();
    detach = undefined;
    wake?.();
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
    const activity = clean(done && item.result !== undefined ? item.result : safeActivity(item));
    const text = `${"  ".repeat(row.depth)}${clean(item.kind)} ${clean(item.label)} · ${state}${activity ? ` · ${activity}` : ""}`;
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
