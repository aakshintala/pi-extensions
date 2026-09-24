// Visible, editable message queue (spec #39). Interactive steer and follow-up
// submissions made while the agent works are held here, shown above Pi's own editor,
// edited in that editor, and handed to Pi with its own delivery rules.
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Spacer, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { fleet, viewerTakes } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts"; // row text is user input
import { editorFocused as mainEditorFocused } from "../../shared/tui/index.ts";

type Lane = "steer" | "followUp";
type Row = { id: number; lane: Lane; text: string; images?: ImageContent[]; error?: string };

const WIDGET = "queue";
const ENTRY = "rig.queue"; // rows and draft saved across /reload
// The token of the entry the last reload wrote, handed to the next runtime in this
// process. An entry without it (a crash, a fork, a later session) is never restored.
const RELOAD = Symbol.for("pi-rig.queue.reload");

/** `/compact [instructions]` or `/reload`, exact text only. */
export const commandOf = (row: Pick<Row, "text" | "images">) => {
  if (row.images?.length) return undefined; // never drop attachments by running a command
  const m = /^\/(?:compact(?:\s+([\s\S]*))?|reload)$/.exec(row.text.trim());
  return m && { kind: m[0].startsWith("/reload") ? ("reload" as const) : ("compact" as const), instructions: m[1]?.trim() || undefined };
};

// Pi's compaction failures that mean there was nothing to do (agent-session.js compact()).
const NOTHING_TO_COMPACT = /^(Nothing to compact|Already compacted)/;

export default function (pi: ExtensionAPI) {
  let rows: Row[] = [];
  let nextId = 1;
  let paused = false; // a failed queued command waits for the next submission or Option+Up
  let running: "compact" | "reload" | undefined; // a command row is executing
  let edit: { row: Row; draft: string } | undefined;
  // Every change of `edit` goes through here: the fleet viewer leaves typed input alone while a row is edited.
  const setEdit = (next: typeof edit) => {
    edit = next;
    fleet().editing = !!next;
  };
  let ctx: ExtensionContext | undefined;
  let tui: any; // from the widget factory
  let reloadRow: Row | undefined; // a /reload row waiting for Pi's main editor
  let reloadDraft: string | undefined; // editor text saved while a queued /reload runs
  let unsubscribeKeys: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => {
    const t = setTimeout(() => (timers.delete(t), fn()), 0);
    timers.add(t);
  };

  const ordered = () => [...rows.filter((r) => r.lane === "steer"), ...rows.filter((r) => r.lane === "followUp")];

  // Pi orders above-editor widgets by their most recent setWidget call, with no order option.
  // Keep this component first even when another extension redraws its widget later.
  const pinAbove = (component: object) => {
    const visit = (node: any): boolean => {
      const children = node?.children;
      if (!Array.isArray(children)) return false;
      const i = children.indexOf(component);
      if (i >= 0) {
        // Keep Pi's leading spacer before the widgets; only reorder widget siblings.
        const firstWidget = children[0] instanceof Spacer ? 1 : 0;
        if (i !== firstWidget) {
          children.splice(i, 1);
          children.splice(firstWidget, 0, component);
          tui.requestRender();
        }
        return true;
      }
      return children.some(visit);
    };
    visit(tui);
  };

  // Always set, even empty (it then renders no lines), so `tui` is known before the first row.
  const draw = () => {
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget(
      WIDGET,
      (t, theme) => {
            tui = t;
            const component = {
              invalidate() {},
              render(width: number) {
                queueMicrotask(() => tui && pinAbove(component));
                const lines: string[] = [];
                for (const [lane, name, when] of [
                  ["steer", "Steering", "next turn"],
                  ["followUp", "Follow-ups", "after the run"],
                ] as const) {
                  const group = rows.filter((r) => r.lane === lane);
                  if (!group.length) continue;
                  const color = lane === "steer" ? "accent" : "warning";
                  lines.push(` ${theme.fg(color, `${name} (${group.length})`)}${theme.fg("dim", ` · ${paused ? "paused" : when}`)}`);
                  for (const r of group) {
                    const command = commandOf(r);
                    const images = r.images?.length ? ` [${r.images.length} image${r.images.length > 1 ? "s" : ""}]` : "";
                    const note = r.error
                      ? theme.fg("error", ` · failed: ${oneLine(r.error)}`)
                      : command
                        ? theme.fg("dim", " · runs when idle")
                        : "";
                    const mark = command ? "⚙" : " ";
                    const text = theme.fg("muted", oneLine(r.text));
                    lines.push(truncateToWidth(` ${mark} ${text}${images}${note}`, width));
                  }
                }
                return lines;
              },
            };
            return component;
          },
    );
  };

  const endEdit = (text?: string) => {
    if (!edit || !ctx) return;
    const { row, draft } = edit;
    if (text !== undefined) row.text = text;
    ctx.ui.setEditorText(draft);
    setEdit(undefined);
    return row;
  };

  const putBack = (row: Row) => {
    rows.push(row);
    rows.sort((a, b) => a.id - b.id);
    draw();
  };

  // Rows ahead of the first command row, in one lane; a command row holds everything behind it.
  const ready = (lane: Lane) => {
    const stop = rows.findIndex((r) => commandOf(r));
    return (stop < 0 ? rows : rows.slice(0, stop)).filter((r) => r.lane === lane);
  };

  const deliver = (batch: Row[], deliverAs?: Lane) => {
    rows = rows.filter((r) => !batch.includes(r));
    draw();
    for (const r of batch) {
      const content = r.images?.length ? [{ type: "text" as const, text: r.text }, ...r.images] : r.text;
      pi.sendUserMessage(content, { ...(deliverAs && { deliverAs }), expandPromptTemplates: true });
    }
  };

  // A boundary drains the whole ready batch at once: queued messages arrive together.
  const atBoundary = (lane: Lane) => {
    if (paused || running) return;
    deliver(ready(lane), lane);
  };

  function dispatchIdle() {
    if (!ctx || paused || running || edit || !rows.length || !ctx.isIdle()) return;
    const batch = ready("steer").length ? ready("steer") : ready("followUp");
    if (batch.length) return deliver(batch);
    runCommand(rows[0]);
  }

  function runCommand(row: Row) {
    const c = ctx!;
    const command = commandOf(row)!;
    const fail = (reason: string) => {
      running = undefined;
      row.error = reason;
      paused = true;
      draw();
    };
    if (command.kind === "compact") {
      running = "compact";
      row.error = undefined;
      draw();
      const done = (notice?: string) => {
        running = undefined;
        rows = rows.filter((r) => r !== row);
        draw();
        if (notice) c.ui.notify(notice, "info");
        dispatchIdle();
      };
      c.compact({
        customInstructions: command.instructions,
        onComplete: () => done(),
        onError: (e) => (NOTHING_TO_COMPACT.test(e.message) ? done("Nothing to compact") : fail(e.message)),
      });
      return;
    }
    running = "reload";
    reloadRow = row;
    replayReload();
  }

  // Pi's own /reload handler, reached through its main editor. With anything else focused
  // (a picker, the label editor) it waits, retried after each key. Deferred so the
  // runtime is not replaced from inside one of our handlers.
  function replayReload() {
    later(() => {
      const row = reloadRow;
      if (!ctx || !row || !editorFocused()) return;
      reloadRow = undefined;
      if (!rows.includes(row)) return (running = undefined), dispatchIdle(); // deleted while waiting
      reloadDraft = ctx.ui.getEditorText(); // Pi clears the editor; restored after the reload
      rows = rows.filter((r) => r !== row);
      draw();
      tui.getFocusedComponent().onSubmit("/reload");
    });
  }

  // Option+Up takes the newest row out of the queue. Moving between rows puts the
  // previous edit back before taking the next, so nothing is silently lost.
  const select = (step: number) => {
    const c = ctx!;
    paused = false;
    if (!edit) {
      const latest = rows.reduce((a, b) => (b.id > a.id ? b : a));
      rows = rows.filter((r) => r !== latest);
      setEdit({ row: latest, draft: c.ui.getEditorText() });
      c.ui.setEditorText(latest.text);
      return draw();
    }
    const current = edit.row;
    current.text = c.ui.getEditorText().trim() || current.text;
    putBack(current);
    const order = ordered();
    const i = order.findIndex((r) => r === current);
    const next = order[(i + step + order.length) % order.length];
    rows = rows.filter((r) => r !== next);
    edit.row = next;
    c.ui.setEditorText(next.text);
    draw();
  };

  const remove = () => {
    const next = ordered().at(-1);
    if (!next) {
      endEdit();
      draw();
      return dispatchIdle();
    }
    rows = rows.filter((r) => r !== next);
    edit!.row = next;
    ctx!.ui.setEditorText(next.text);
    draw();
  };

  // Keys are read here rather than through registerShortcut: overriding Pi's Option+Up
  // that way prints an "[Extension issues]" warning at every start. Only while Pi's editor
  // has focus, so pickers keep their own Option+Up/Down.
  const editorFocused = () => mainEditorFocused(tui);

  const extensionCommand = (text: string) => {
    const name = /^\/(\S+)/.exec(text)?.[1];
    return !!name && pi.getCommands().some((c) => c.source === "extension" && c.name === name);
  };

  const onKey = (data: string) => {
    if (!ctx || (!rows.length && !edit) || !editorFocused()) return;
    const handled = (() => {
      if (matchesKey(data, "alt+up")) return select(-1), true;
      if (edit && matchesKey(data, "alt+down")) return select(1), true;
      if (edit && matchesKey(data, "alt+x")) return remove(), true;
      if (edit && matchesKey(data, "escape")) {
        const row = endEdit(ctx!.ui.getEditorText());
        if (row) putBack(row);
        if (ctx!.isIdle()) dispatchIdle();
        return false; // Pi handles Esc: abort this turn, then the queued steer starts a new turn
      }
      // Enter while editing on /compact, /reload or an extension command: Pi would run it
      // before the input event, so save it in place here instead.
      const text = ctx!.ui.getEditorText().trim();
      if (!edit || !matchesKey(data, "enter") || !(commandOf({ text }) || extensionCommand(text))) return false;
      const row = endEdit(text);
      if (row) putBack(row);
      if (ctx!.isIdle()) dispatchIdle();
      return true;
    })();
    return handled ? { consume: true } : undefined;
  };

  // Enter on /compact or /reload while the agent works queues a command row.
  const onCommandKey = (data: string) => {
    if (!ctx || ctx.isIdle() || edit || !matchesKey(data, "enter") || !editorFocused()) return;
    const text = ctx.ui.getEditorText().trim();
    if (!commandOf({ text })) return;
    rows.push({ id: nextId++, lane: "followUp", text });
    paused = false;
    ctx.ui.setEditorText("");
    draw();
    return { consume: true };
  };

  pi.on("session_start", (event, c) => {
    ctx = c;
    const token = (globalThis as any)[RELOAD];
    delete (globalThis as any)[RELOAD];
    const saved = (c.sessionManager.getEntries() as any[]).findLast((e) => e.type === "custom" && e.customType === ENTRY)?.data;
    if (event.reason === "reload" && token && saved?.token === token) {
      rows = saved.rows.map((r: Row) => ({ ...r, id: nextId++ }));
      paused = !!saved.paused;
      if (saved.draft) c.ui.setEditorText(saved.draft);
      later(dispatchIdle);
    }
    if (c.hasUI)
      unsubscribeKeys = c.ui.onTerminalInput((data) => {
        if (reloadRow) replayReload(); // focus may be back on the editor
        return onKey(data) ?? onCommandKey(data);
      });
    draw();
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "reload" && (rows.length || edit || reloadDraft)) {
      // A retrieved row is absent from rows; save its current editor text before Pi replaces the runtime.
      const savedRows = edit ? [...rows, { ...edit.row, text: ctx?.ui.getEditorText() ?? edit.row.text }].sort((a, b) => a.id - b.id) : rows;
      const token = crypto.randomUUID();
      pi.appendEntry(ENTRY, { token, rows: savedRows, paused, draft: edit?.draft ?? reloadDraft });
      (globalThis as any)[RELOAD] = token;
    }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    unsubscribeKeys?.();
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    rows = [];
    setEdit(undefined);
    paused = false;
    running = undefined;
    ctx = tui = reloadRow = reloadDraft = unsubscribeKeys = undefined;
  });

  pi.on("input", (event, c) => {
    if (event.source !== "interactive") return { action: "continue" };
    ctx = c;
    if (edit) {
      const row = endEdit(event.text);
      if (row) {
        putBack(row);
        if (ctx.isIdle()) dispatchIdle();
      }
      return { action: "handled" };
    }
    // Steering the item the fleet viewer shows, whichever extension loaded first.
    if (viewerTakes(event.text)) return { action: "continue" };
    paused = false;
    if (!event.streamingBehavior) return { action: "continue" };
    rows.push({ id: nextId++, lane: event.streamingBehavior, text: event.text, ...(event.images?.length && { images: event.images }) });
    draw();
    // A steer should not wait on a running command: it moves to the background, its tool call returns, and the turn ends.
    if (event.streamingBehavior === "steer") fleet().backgroundAll(c.sessionManager.getSessionId());
    return { action: "handled" };
  });

  const aborted = (m: any, c: ExtensionContext) => c.signal?.aborted || (m?.role === "assistant" && m.stopReason === "aborted");

  pi.on("turn_end", (event, c) => {
    ctx = c;
    if (!aborted(event.message, c)) atBoundary("steer");
    draw();
  });

  pi.on("agent_end", (event, c) => {
    ctx = c;
    const last: any = event.messages.at(-1);
    // An aborted run ends before any queued steer can join it. Deliver it when idle.
    if (aborted(last, c)) return;
    // Pi decides on retry or compaction after agent_end; a follow-up now would hide that.
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "length")) return;
    atBoundary(ready("steer").length ? "steer" : "followUp");
  });

  pi.on("agent_settled", (_event, c) => {
    ctx = c;
    draw();
    dispatchIdle();
  });
}
