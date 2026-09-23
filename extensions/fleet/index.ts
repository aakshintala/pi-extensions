// FleetView (spec #29, #44): the list of background work below the editor.
// Items come from the shared registry (shared/fleet); this extension is the
// only one that draws them. Enter or a click opens an item in the viewer frame
// (#45, viewer.ts). It also delivers the session's notices (#46) and
// keeps a run without the UI alive until the work it started returns.
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, matchesKey, MouseRegion, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { duration, fleet, isFinished, viewerTakes, type Item, type Notice } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { editorFocused } from "../../shared/tui/index.ts";
import { createViewer, type Viewer } from "./viewer.ts";

/** Most lines FleetView takes, including the "… N more" line. */
const MAX_LINES = 6;
const MAIN = "main";
const NOTICE = "rig.notice";
const BLOCKED = Symbol.for("pi-rig.fleet.ctrlBBlocked");

/**
 * Ctrl+B backgrounds only once the user frees it from Pi's default cursor-left binding (#29).
 * Read live: /reload re-reads keybindings.json after session_start.
 */
const ctrlBFree = () => !getKeybindings().getKeys("tui.editor.cursorLeft").includes("ctrl+b");

/**
 * Warns when Ctrl+B becomes blocked, never twice in a row. Checked at session start and on
 * every key: /reload re-reads keybindings.json only after session_start, so a change shows
 * at the next key. The state lives on globalThis so a reload does not repeat the warning.
 */
function checkCtrlB(ctx: ExtensionContext) {
  const g = globalThis as { [BLOCKED]?: boolean };
  const blocked = !ctrlBFree();
  if (blocked && !g[BLOCKED]) {
    ctx.ui.notify(`Ctrl+B moves the cursor left, so it cannot background commands. Add "tui.editor.cursorLeft": ["left"] to ${join(getAgentDir(), "keybindings.json")}`, "warning");
  }
  g[BLOCKED] = blocked;
}

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

/** A producer's activity line; a producer that throws breaks only its own row. */
function safeActivity(item: Item) {
  try {
    return item.activity();
  } catch {
    return "activity failed";
  }
}

const ICON = { completed: ["success", "✓"], failed: ["error", "✗"], stopped: ["warning", "■"] } as const;

/** One themed line per notice; a failed or stopped item's error follows in full. */
const renderNotice: MessageRenderer = (message, { outputPad }, theme) => {
  const item = message.details as Notice["item"] | undefined;
  const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
  if (!item) return new Text(theme.fg("muted", content.split("\n").map(oneLine).join("\n")), outputPad, 0);
  const [color, icon] = isFinished(item.status) ? ICON[item.status as keyof typeof ICON] : (["accent", "●"] as const);
  const state = isFinished(item.status) ? (item.status === "completed" ? "done " : `${item.status} `) : "";
  const head = `${theme.fg(color, icon)} ${oneLine(item.kind)} ${oneLine(item.label)} · ${state}${duration(item.ms)}`;
  const body = isFinished(item.status) ? item.result ?? "" : content;
  if (item.status === "failed" || item.status === "stopped") {
    const lines = body.split("\n").map(oneLine).filter(Boolean);
    return new Text([head, ...lines.map((l) => "  " + theme.fg(color, l))].join("\n"), outputPad, 0);
  }
  const first = oneLine(body.split("\n")[0] ?? "");
  return new Text(head + (first ? theme.fg("muted", ` · ${first}`) : ""), outputPad, 0);
};

/** The one message a run without the UI gets when it ends with work running. */
function listing(items: Item[], now: number) {
  const rows = items.map((i) => `- ${oneLine(i.kind)} ${oneLine(i.label)} (id ${oneLine(i.id)}): ${i.status}, ${duration(now - i.startedAt)}`);
  return [
    "Your run is ending with work still running:",
    ...rows,
    "Stop what you no longer need. The session stays open until the rest finishes, and each result arrives as a notice.",
  ].join("\n");
}

/**
 * Whether a queued message will continue the run anyway: a user steer or follow-up, or
 * one of our notices (always sent as a steer). A custom message sent with
 * `triggerTurn: false` does not continue it.
 * ponytail: another extension's custom steer is not told apart from that, so the wait
 * holds it until the next notice; tell them apart if Pi ever exposes the steer queue.
 */
const continues = (pending: readonly { role: string; customType?: string }[]) =>
  pending.some((m) => m.role !== "custom" || m.customType === NOTICE);

export default function (pi: ExtensionAPI) {
  let cleanup: (() => void) | undefined;
  let viewer: Viewer | undefined; // the open session's viewer frame, TUI mode only
  let detach: (() => void) | undefined;
  let wake: (() => void) | undefined; // ends a session-end wait
  let listed = false; // this run's end already listed its running work

  pi.registerMessageRenderer(NOTICE, renderNotice);

  pi.on("input", (event) => {
    // While an item is open, what the user types steers it; the main session gets nothing.
    // Slash commands still go to Pi.
    if (viewer?.active() && event.source === "interactive" && viewerTakes(event.text)) {
      viewer.steer(event.text);
      return { action: "handled" };
    }
    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    detach?.();
    if (ctx.mode === "tui") {
      checkCtrlB(ctx);
      const mounted = mount(ctx);
      viewer = mounted.viewer;
      cleanup = mounted.cleanup;
    }
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
  pi.on("agent_before_settle", async (event, ctx) => {
    if (ctx.hasUI || continues(event.context.pendingMessages)) return;
    const registry = fleet();
    const owner = ctx.sessionManager.getSessionId();
    const running = () => registry.items().filter((i) => i.owner === owner && !isFinished(i.status));
    if (running().length === 0) return;
    if (!listed) {
      listed = true;
      const content = listing(running(), registry.now());
      return { entries: [...event.entries, { type: "custom_message", customType: NOTICE, content, display: true }], continue: true };
    }
    // No cap on the wait (spec #29): the command, shell timeout or caller's kill bounds it.
    // Pi emits no event on a bare abort(), so an abort waits for the items too.
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

  // Session replacement aborts the run and waits for idle: end the wait first.
  pi.on("session_before_switch", () => wake?.());
  pi.on("session_before_fork", () => wake?.());

  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
    viewer = undefined;
    detach?.();
    detach = undefined;
    wake?.();
  });
}

function mount(ctx: ExtensionContext): { viewer: Viewer; cleanup: () => void } {
  const registry = fleet();
  let tui: TUI | undefined;
  let focused = false;
  let selected = 0;
  let top = 0; // first row shown
  let timer: ReturnType<typeof setInterval> | undefined;
  const viewer = createViewer(ctx, () => tui);
  const active = () => viewer.active() ?? MAIN; // the item in the chat area

  const current = () => rows(registry.items());

  const hint = () => registry.foregrounds() > 0 && ctrlBFree();

  // Rows shown, as indices into current(), plus the hidden count. A stop confirmation and the Ctrl+B hint each take one line of the budget.
  function window(all: Row[]) {
    selected = Math.min(selected, all.length - 1);
    const budget = MAX_LINES - (viewer.confirmation() ? 1 : 0) - (hint() ? 1 : 0);
    if (all.length <= budget) return { start: 0, end: all.length, hidden: 0 };
    const size = budget - 1;
    top = Math.max(0, Math.min(Math.max(top, selected - size + 1), selected, all.length - size));
    return { start: top, end: top + size, hidden: all.length - size };
  }

  function line(row: Row, index: number, theme: Theme) {
    const id = row.item?.id ?? MAIN;
    const mark = (focused && index === selected ? "›" : " ") + (id === active() ? "●" : " ");
    if (!row.item) return theme.fg("accent", mark) + " main";
    const item = row.item;
    const done = isFinished(item.status);
    const state =
      item.status === "queued"
        ? "queued"
        : (done ? (item.status === "completed" ? "done " : `${item.status} `) : "") +
          duration((item.endedAt ?? registry.now()) - item.startedAt);
    const activity = oneLine(done && item.result !== undefined ? item.result : safeActivity(item));
    const text = `${"  ".repeat(row.depth)}${oneLine(item.kind)} ${oneLine(item.label)} · ${state}${activity ? ` · ${activity}` : ""}`;
    const color = item.status === "failed" ? "error" : done ? "muted" : "text";
    return theme.fg("accent", mark) + " " + theme.fg(color, text);
  }

  const view = {
    render(width: number) {
      const all = current();
      const theme = ctx.ui.theme;
      const out: string[] = [];
      if (all.length > 1) {
        const { start, end, hidden } = window(all);
        out.push(...all.slice(start, end).map((row, i) => line(row, start + i, theme)));
        if (hidden) out.push(theme.fg("dim", `   … ${hidden} more`));
        const confirm = viewer.confirmation();
        if (confirm) out.push(theme.fg("warning", ` ${confirm}`));
      }
      // Last, so a click's row index still counts from the first row.
      if (hint()) out.push(theme.fg("dim", " ctrl+b to run in background"));
      return out.map((l) => truncateToWidth(l, width));
    },
    invalidate() {},
  };
  const region = new MouseRegion(view, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const all = current();
    if (all.length === 1) return undefined; // only the Ctrl+B hint is showing
    const { start, end } = window(all);
    const index = start + event.y;
    if (index >= end) return undefined;
    selected = index;
    choose(all[index]);
    hold();
    return { handled: true, render: true };
  });

  // Opens a row in the viewer, or goes back to the chat for the main row. Focus stays on the row (#136).
  const choose = (row: Row) => {
    focused = true;
    if (row.item) viewer.open(row.item);
    else viewer.close();
  };

  // The selected item does not decay (#137): tell the registry, and follow it when rows above it leave.
  const hold = () => {
    registry.selected = focused ? current()[selected]?.item?.id : undefined;
  };

  const redraw = () => {
    const held = current().findIndex((r) => r.item && r.item.id === registry.selected);
    if (held >= 0) selected = held;
    const shown = viewer.active();
    if (shown && !registry.get(shown)) viewer.close(); // pruned: nothing left to show
    viewer.refresh(); // a producer update often means new log output
    const running = registry.items().some((i) => !isFinished(i.status));
    if (running && !timer) timer = setInterval(() => tui?.requestRender(), 1000);
    if (!running && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (current().length === 1) focused = false;
    hold();
    tui?.requestRender();
  };
  const unsubscribe = registry.subscribe(redraw);

  const unlisten = ctx.ui.onTerminalInput((data) => {
    const result = key(data);
    hold();
    return result;
  });
  function key(data: string) {
    if (data.startsWith("\x1b[<") || isKeyRelease(data)) return undefined;
    checkCtrlB(ctx);
    if (viewer.overlay()) focused = false; // the overlay covers FleetView and takes the keys
    // First, so at a stop confirmation Ctrl+B is "any other key" and cancels. Esc in FleetView
    // only returns to the editor, with the viewer still open; a second Esc there closes it.
    const leave = focused && matchesKey(data, "escape") && !viewer.confirmation();
    if (!leave && viewer.handleKey(data)) return { consume: true };
    if (matchesKey(data, "ctrl+b") && hint() && editorFocused(tui)) {
      registry.backgroundAll();
      return { consume: true };
    }
    // The overlay covers FleetView and takes every other key.
    if (current().length === 1 || viewer.overlay()) return undefined;
    if (!focused) {
      if (!(matchesKey(data, "down") || matchesKey(data, "left")) || ctx.ui.getEditorText() !== "") return undefined;
      focused = true;
      selected = 0;
    } else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
    else if (matchesKey(data, "down")) selected = Math.min(current().length - 1, selected + 1);
    else if (matchesKey(data, "escape")) focused = false;
    else if (matchesKey(data, "enter")) choose(current()[selected]);
    else {
      focused = false; // any other key goes back to the editor
      tui?.requestRender();
      return undefined;
    }
    tui?.requestRender();
    return { consume: true };
  }

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
  const cleanup = () => {
    if (done) return;
    done = true;
    viewer.close();
    unsubscribe();
    unlisten();
    registry.selected = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
    tui = undefined;
  };
  return { viewer, cleanup };
}
