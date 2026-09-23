// Visible, editable message queue (spec #39). Interactive steer and follow-up
// submissions made while the agent works are held here, shown above Pi's own editor,
// edited in that editor, and handed to Pi with its own delivery rules.
import type { ImageContent } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { fleet, viewerTakes } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts"; // row text is user input
import { editorFocused as mainEditorFocused } from "../../shared/tui/index.ts";

type Lane = "steer" | "followUp";
type Row = { id: number; lane: Lane; text: string; images?: ImageContent[]; error?: string };
type Mode = "all" | "one-at-a-time";

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
  let paused = false; // after an abort, until the next submission or Option+Up
  let running: "compact" | "reload" | undefined; // a command row is executing
  let edit: { id: number; draft: string } | undefined;
  // Every change of `edit` goes through here: the fleet viewer leaves typed input alone while a row is edited.
  const setEdit = (next: typeof edit) => {
    edit = next;
    fleet().editing = !!next;
  };
  let modes: Record<Lane, Mode> = { steer: "one-at-a-time", followUp: "one-at-a-time" };
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

  // Always set, even empty (it then renders no lines), so `tui` is known before the first row.
  const draw = () => {
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget(
      WIDGET,
      (t, theme) => {
            tui = t;
            return {
              invalidate() {},
              render(width: number) {
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
                    const selected = r.id === edit?.id;
                    const command = commandOf(r);
                    const images = r.images?.length ? ` [${r.images.length} image${r.images.length > 1 ? "s" : ""}]` : "";
                    const note = r.error
                      ? theme.fg("error", ` · failed: ${oneLine(r.error)}`)
                      : command
                        ? theme.fg("dim", " · runs when idle")
                        : "";
                    const mark = selected ? theme.fg(color, "›") : command ? "⚙" : " ";
                    const text = selected ? theme.fg(color, oneLine(r.text)) : theme.fg("muted", oneLine(r.text));
                    lines.push(truncateToWidth(` ${mark} ${text}${images}${note}`, width));
                  }
                }
                return lines;
              },
            };
          },
    );
  };

  const endEdit = (text?: string) => {
    if (!edit || !ctx) return;
    const row = rows.find((r) => r.id === edit!.id);
    if (row && text !== undefined) row.text = text;
    ctx.ui.setEditorText(edit.draft);
    setEdit(undefined);
    draw();
    if (ctx.isIdle()) dispatchIdle();
  };

  // Rows ahead of the first command row, in one lane; a command row holds everything behind it.
  const ready = (lane: Lane) => {
    const stop = rows.findIndex((r) => commandOf(r));
    return (stop < 0 ? rows : rows.slice(0, stop)).filter((r) => r.lane === lane);
  };

  const deliver = (batch: Row[], deliverAs?: Lane) => {
    rows = rows.filter((r) => !batch.includes(r));
    if (edit && batch.some((r) => r.id === edit!.id)) {
      ctx?.ui.setEditorText(edit.draft);
      setEdit(undefined);
      ctx?.ui.notify("The queued message you were editing was delivered", "info");
    }
    draw();
    for (const r of batch) {
      const content = r.images?.length ? [{ type: "text" as const, text: r.text }, ...r.images] : r.text;
      pi.sendUserMessage(content, { ...(deliverAs && { deliverAs }), expandPromptTemplates: true });
    }
  };

  const atBoundary = (lane: Lane) => {
    if (paused || running) return;
    const batch = ready(lane);
    deliver(modes[lane] === "all" ? batch : batch.slice(0, 1), lane);
  };

  function dispatchIdle() {
    if (!ctx || paused || running || edit || !rows.length || !ctx.isIdle()) return;
    const next = ready("steer")[0] ?? ready("followUp")[0];
    if (next) return deliver([next]);
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

  // Option+Up selects the most recent row, then moves up; Option+Down moves down. The
  // row being left keeps what was typed into it.
  const select = (step: number) => {
    const c = ctx!;
    paused = false;
    if (!edit) {
      const latest = rows.reduce((a, b) => (b.id > a.id ? b : a));
      setEdit({ id: latest.id, draft: c.ui.getEditorText() });
      c.ui.setEditorText(latest.text);
      return draw();
    }
    const order = ordered();
    const i = order.findIndex((r) => r.id === edit!.id);
    order[i].text = c.ui.getEditorText().trim() || order[i].text;
    const next = order[(i + step + order.length) % order.length];
    edit.id = next.id;
    c.ui.setEditorText(next.text);
    draw();
  };

  const remove = () => {
    const order = ordered();
    const i = order.findIndex((r) => r.id === edit!.id);
    rows = rows.filter((r) => r.id !== edit!.id);
    const next = ordered()[Math.min(i, rows.length - 1)];
    if (!next) return endEdit();
    edit!.id = next.id;
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
    if (!ctx || !rows.length || !editorFocused()) return;
    const handled = (() => {
      if (matchesKey(data, "alt+up")) return select(-1), true;
      if (edit && matchesKey(data, "alt+down")) return select(1), true;
      if (edit && matchesKey(data, "alt+x")) return remove(), true;
      if (edit && matchesKey(data, "escape")) return endEdit(), true;
      // Enter while editing on /compact, /reload or an extension command: Pi would run it
      // before the input event, so save it in place here instead.
      const text = ctx!.ui.getEditorText().trim();
      if (!edit || !matchesKey(data, "enter") || !(commandOf({ text }) || extensionCommand(text))) return false;
      return endEdit(text), true;
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
    const settings = SettingsManager.create(c.cwd);
    modes = { steer: settings.getSteeringMode(), followUp: settings.getFollowUpMode() };
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
    if (event.reason === "reload" && (rows.length || reloadDraft)) {
      const token = crypto.randomUUID();
      pi.appendEntry(ENTRY, { token, rows, paused, draft: reloadDraft });
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
      endEdit(event.text);
      return { action: "handled" };
    }
    // Steering the item the fleet viewer shows, whichever extension loaded first.
    if (viewerTakes(event.text)) return { action: "continue" };
    paused = false;
    if (!event.streamingBehavior) return { action: "continue" };
    rows.push({ id: nextId++, lane: event.streamingBehavior, text: event.text, ...(event.images?.length && { images: event.images }) });
    draw();
    return { action: "handled" };
  });

  const aborted = (m: any, c: ExtensionContext) => c.signal?.aborted || (m?.role === "assistant" && m.stopReason === "aborted");

  pi.on("turn_end", (event, c) => {
    ctx = c;
    if (aborted(event.message, c)) paused = rows.length > 0;
    atBoundary("steer");
    draw();
  });

  pi.on("agent_end", (event, c) => {
    ctx = c;
    const last: any = event.messages.at(-1);
    if (aborted(last, c)) paused = rows.length > 0;
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
