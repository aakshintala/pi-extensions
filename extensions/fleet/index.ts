// FleetView (spec #29, #44): the list of background work below the editor.
// Items come from the shared registry (shared/fleet); this extension is the
// only one that draws them. Enter or a click opens an item in the viewer frame
// (#45, viewer.ts). It also delivers the session's notices (#46) and
// keeps a run without the UI alive until the work it started returns.
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, MouseRegion, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { duration, fleet, isFinished, viewerTakes, type Item, type Notice } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { ctrlBFree, editorFocused } from "../../shared/tui/index.ts";
import { createViewer, endedAs, stateOf, type Viewer } from "./viewer.ts";

/** Most lines FleetView takes, including the "… N more" line. */
const MAX_LINES = 6;
const MAIN = "main";
/** Shown under the rows while FleetView has focus (#141). */
const KEYS = " Enter to view · x to stop · ctrl+x ctrl+k to stop all agents";
const NOTICE = "rig.notice";
const BLOCKED = Symbol.for("pi-rig.fleet.ctrlBBlocked");

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

type Row = { item?: Item; shells?: Item[]; depth: number };

/** Main session first, then every item with children under their parent. */
function rows(items: readonly Item[]): Row[] {
  const shells = items.filter((i) => i.kind === "shell" && i.status === "running");
  const visible = items.filter((i) => i.kind !== "shell");
  const ids = new Set(visible.map((i) => i.id));
  const out: Row[] = [{ depth: 0 }];
  const placed = new Set<Item>();
  const add = (parent: string | undefined, depth: number) => {
    for (const item of visible) {
      const p = item.parentId && ids.has(item.parentId) && item.parentId !== item.id ? item.parentId : undefined;
      if (p !== parent) continue;
      out.push({ item, depth });
      placed.add(item);
      add(item.id, depth + 1);
    }
  };
  add(undefined, 0);
  // Items in a parent cycle have no root; show them at the top level.
  for (const item of visible) if (!placed.has(item)) out.push({ item, depth: 0 });
  if (shells.length) out.push({ shells, depth: 0 });
  return out;
}

/** A producer's activity line and detail fields; a producer that throws breaks only its own row. */
function safeActivity(item: Item) {
  try {
    return item.activity();
  } catch {
    return "activity failed";
  }
}
function safeDetail(item: Item) {
  try {
    return item.detail?.() ?? [];
  } catch {
    return ["detail failed"];
  }
}

const ICON = { completed: ["success", "✓"], failed: ["error", "✗"], stopped: ["warning", "■"] } as const;

/** One themed line per notice; a failed or stopped item's error follows in full. */
const renderNotice: MessageRenderer = (message, { outputPad }, theme) => {
  const item = message.details as Notice["item"] | undefined;
  const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
  if (!item) return new Text(theme.fg("muted", content.split("\n").map(oneLine).join("\n")), outputPad, 0);
  const [color, icon] = isFinished(item.status) ? ICON[item.status as keyof typeof ICON] : (["accent", "●"] as const);
  const state = endedAs(item.status);
  // The same fields FleetView rows show (model, tokens, cost...), so a finished notice
  // carries what the row did (#5); a producer that throws keeps only its row broken.
  const fields = safeDetail(item).map(oneLine).filter(Boolean).map((f) => ` · ${f}`).join("");
  const head = `${theme.fg(color, icon)} ${oneLine(item.kind)} ${oneLine(item.label)} · ${state}${duration(item.ms)}${fields}`;
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
    // A completed shell job or monitor folds into the tool groups around it: it is still
    // delivered (the model reports it in text), but draws no rows. Agent completions,
    // failures, stops and running warnings stay visible.
    detach = fleet().attach(ctx.sessionManager.getSessionId(), (notice) => {
      const item = notice.item;
      const display = !item || item.kind === "agent" || item.status !== "completed";
      pi.sendMessage({ customType: NOTICE, content: notice.text, display, details: item }, { triggerTurn: true, deliverAs: "steer" });
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
  let chord = false; // Ctrl+X was pressed in FleetView: Ctrl+K next stops every agent
  let selected = 0;
  let top = 0; // first item shown
  let timer: ReturnType<typeof setInterval> | undefined;
  const viewer = createViewer(ctx, () => tui);
  const active = () => viewer.active() ?? MAIN; // the item in the chat area

  const current = () => rows(registry.items());

  // Ctrl+B can move a foreground command to the background. Its hint is on the running call (#139).
  const canBackground = () => registry.foregrounds() > 0 && ctrlBFree();

  const activityOf = (item: Item) => oneLine(isFinished(item.status) && item.result !== undefined ? item.result : safeActivity(item));
  const height = (row: Row) => row.item?.kind === "agent" && activityOf(row.item) ? 2 : 1;

  // Fit whole items into six lines. Reserve one line for the hidden count when any item is offscreen.
  function window(all: Row[]) {
    selected = Math.min(selected, all.length - 1);
    const budget = MAX_LINES - (focused ? 1 : 0);
    if (all.reduce((n, row) => n + height(row), 0) <= budget) return { start: 0, end: all.length, hidden: 0 };
    const endAt = (start: number) => {
      let used = 0;
      let end = start;
      while (end < all.length && used + height(all[end]) <= budget - 1) used += height(all[end++]);
      return end;
    };
    top = Math.min(top, selected);
    while (selected >= endAt(top) && top < selected) top++;
    const end = endAt(top);
    return { start: top, end, hidden: all.length - (end - top) };
  }

  function lines(row: Row, index: number, theme: Theme, width: number): string[] {
    const id = row.item?.id ?? MAIN;
    const onScreen = row.shells ? row.shells.some((i) => i.id === viewer.active()) : id === active();
    const mark = (focused && index === selected ? "›" : " ") + (onScreen ? "●" : " ");
    if (row.shells) return [theme.fg("accent", mark) + ` ${row.shells.length} ${row.shells.length === 1 ? "shell" : "shells"} running in background`];
    if (!row.item) return [theme.fg("accent", mark) + " main"];
    const item = row.item;
    const done = isFinished(item.status);
    const state = stateOf(item);
    const activity = activityOf(item);
    // The label and status always stay: the label is shortened to leave room for the status (#138).
    const name = oneLine(item.label);
    const head = `${"  ".repeat(row.depth)}${oneLine(item.kind)} `;
    const tail = ` · ${state}`;
    const room = Math.max(1, width - 3 - visibleWidth(head + tail));
    let text = head + truncateToWidth(name, room, "…") + tail;
    // Detail fields drop from the right when narrow. Agent activity has its own linked line.
    const fits = (more: string) => 3 + visibleWidth(`${text} · ${more}`) <= width;
    let dropped = false;
    for (const field of safeDetail(item).map(oneLine).filter(Boolean)) {
      if (!fits(field)) {
        dropped = true;
        break;
      }
      text += ` · ${field}`;
    }
    if (item.kind !== "agent" && activity && !dropped && fits(activity.slice(0, 6))) text += ` · ${activity}`;
    const color = item.status === "failed" ? "error" : done ? "muted" : "text";
    const out = [theme.fg("accent", mark) + " " + theme.fg(color, text)];
    if (item.kind === "agent" && activity) out.push(theme.fg("muted", `${"  ".repeat(row.depth + 2)}└─ ${activity}`));
    return out;
  }

  const view = {
    render(width: number) {
      const all = current();
      const theme = ctx.ui.theme;
      const out: string[] = [];
      if (all.length > 1) {
        const { start, end, hidden } = window(all);
        out.push(...all.slice(start, end).flatMap((row, i) => lines(row, start + i, theme, width)));
        if (hidden) out.push(theme.fg("dim", `   … ${hidden} more`));
        if (focused) out.push(theme.fg("dim", KEYS));
      }
      return out.map((l) => truncateToWidth(l, width));
    },
    invalidate() {},
  };
  const region = new MouseRegion(view, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const all = current();
    if (all.length === 1) return undefined; // nothing is drawn
    const { start, end } = window(all);
    let y = 0;
    let index = start;
    while (index < end && y + height(all[index]) <= event.y) y += height(all[index++]);
    if (index >= end) return undefined;
    selected = index;
    choose(all[index]);
    hold();
    return { handled: true, render: true };
  });

  const pickShell = (row: Row, title: string, action: (item: Item) => void) => {
    const options = row.shells!.map((i) => `${oneLine(i.label)} · ${oneLine(i.id)}`);
    void ctx.ui.select(title, options).then((choice) => {
      const id = row.shells?.[options.indexOf(choice ?? "")]?.id;
      const item = id && registry.get(id);
      if (!done && item?.kind === "shell" && item.status === "running") action(item);
    }, () => {});
  };

  // Opens a row in the viewer, or goes back to the chat for the main row. Focus stays on the row (#136).
  const choose = (row: Row) => {
    focused = true;
    if (row.shells) pickShell(row, "Running shells", (item) => viewer.open(item));
    else if (row.item) viewer.open(row.item);
    else viewer.close();
  };

  // x (#141): stops a running or queued item at once, through its own stop(); a failure is shown.
  const stop = (item: Item | undefined) => {
    if (!item || isFinished(item.status)) return;
    const failed = (e: unknown) => ctx.ui.notify(`Stopping ${oneLine(item.kind)} ${oneLine(item.label)} failed: ${oneLine((e as Error)?.message ?? e)}`, "error");
    try {
      void Promise.resolve(item.stop()).catch(failed);
    } catch (e) {
      failed(e);
    }
  };
  // Ctrl+X Ctrl+K: every agent this session started; each one's stop takes its subtree with it.
  const stopAll = () => {
    const owner = ctx.sessionManager.getSessionId();
    for (const item of registry.items()) if (item.kind === "agent" && item.owner === owner) stop(item);
  };

  // The selected item does not decay (#137): tell the registry, and follow it when rows above it leave.
  const hold = (all = current()) => {
    registry.selected = focused ? all[selected]?.item?.id : undefined;
  };

  // An open log is read by its own watcher (viewer.ts), not here.
  const redraw = () => {
    const all = current();
    const held = all.findIndex((r) => r.item && r.item.id === registry.selected);
    if (held >= 0) selected = held;
    const shown = viewer.active();
    if (shown && !registry.get(shown)) viewer.close(); // pruned: nothing left to show
    const running = registry.items().some((i) => !isFinished(i.status));
    if (running && !timer) timer = setInterval(() => tui?.requestRender(), 1000);
    if (!running && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (all.length === 1) focused = false;
    hold(all);
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
    const wasChord = chord;
    chord = false;
    checkCtrlB(ctx);
    if (viewer.overlay()) focused = false; // the overlay covers FleetView and takes the keys
    // Esc in FleetView only returns to the editor, with the viewer still open; a second Esc there closes it.
    if (!focused && viewer.handleKey(data)) return { consume: true };
    if (matchesKey(data, "ctrl+b") && canBackground() && editorFocused(tui)) {
      registry.backgroundAll();
      return { consume: true };
    }
    // Pickers and dialogs take their own keys, even when FleetView was focused before they opened.
    if (current().length === 1 || viewer.overlay() || !editorFocused(tui)) return undefined;
    if (!focused) {
      // No hijack: when a picker, panel or overlay owns the keys the editor is not
      // focused, so Down/Left stay theirs (ask_user's panel keeps its arrows).
      if (!(matchesKey(data, "down") || matchesKey(data, "left")) || ctx.ui.getEditorText() !== "" || !editorFocused(tui)) return undefined;
      focused = true;
      // The item open in the viewer, or main when none is.
      selected = Math.max(0, current().findIndex((r) => r.item && r.item.id === viewer.active()));
    } else if (wasChord && matchesKey(data, "ctrl+k")) stopAll();
    else if (matchesKey(data, "ctrl+x")) {
      chord = true;
      return { consume: true };
    } else if (matchesKey(data, "x")) {
      const row = current()[selected];
      if (row.shells) pickShell(row, "Stop running shell", stop);
      else stop(row.item);
    }
    else if (matchesKey(data, "up")) {
      if (selected === 0) focused = false; // past the first row: back to the editor
      else selected -= 1;
    } else if (matchesKey(data, "down")) {
      if (selected === current().length - 1) focused = false; // past the last row: back to the editor
      else selected += 1;
    }
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
