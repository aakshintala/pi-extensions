// The viewer frame (spec #29, #45): one item's transcript or log in place of
// Pi's chat container, or in a full-size overlay when Pi's layout is not the
// tested one, and in regular mode, which has no scroll view to follow with.
// The frame, not the producer, handles closing and steer, so they work the
// same for every item. Stopping is FleetView's (x, #141).
import { getMarkdownTheme, UserMessageComponent, VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  isViewportTUI,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { unwatchFile, watchFile } from "node:fs";
import { duration, fleet, isFinished, type Item } from "../../shared/fleet/index.ts";
import { oneLine } from "../../shared/text/index.ts";
import { logSource } from "./log.ts";

/** The Pi version the chat-area swap was tested on (umbrella #1: guarded patch). */
export const TESTED_PI = "0.87.1";
/** How often an open log is checked for new output, in ms. */
const LOG_POLL_MS = 200;

/**
 * Pi's chat container and its parent. Pi mounts `documentContainer`
 * (header, loaded resources, chat) as the TUI's first child in both modes.
 * Nothing when the version or the shape differs: the viewer then uses an overlay.
 * Restoring the chat looks the parent up again the same way.
 */
export function findChat(tui: TUI, version = VERSION) {
  if (version !== TESTED_PI) return;
  const doc = (tui as unknown as Container).children?.[0];
  const kids = doc instanceof Container ? doc.children : undefined;
  if (kids?.length === 3 && kids.every((k) => k instanceof Container)) return { parent: doc as Container, chat: kids[2] };
}

/** "done ", "failed " or "stopped " for a finished status, else nothing. */
export const endedAs = (status: Item["status"]) => (isFinished(status) ? (status === "completed" ? "done " : `${status} `) : "");
/** An item's state for its row and header: queued, or how long it has run or ran. */
export const stateOf = (item: Item) =>
  item.status === "queued" ? "queued" : endedAs(item.status) + duration((item.endedAt ?? fleet().now()) - item.startedAt);

/** The item's header line: kind, label, status, running time and the frame's keys. */
function header(ctx: ExtensionContext, id: string): Component {
  return {
    render(width) {
      const item = fleet().get(id);
      if (!item) return [];
      const theme = ctx.ui.theme;
      const state = stateOf(item);
      const keys = `esc back${item.steer ? " · enter steers" : ""}`;
      return [truncateToWidth(` ${theme.fg("accent", `${oneLine(item.kind)} ${oneLine(item.label)}`)} · ${state} ${theme.fg("dim", `· ${keys}`)}`, width)];
    },
    invalidate() {},
  };
}

/** A log file's lines, wrapped to the width; rewrapped only when the lines or the width change. */
function logView(lines: () => string[]): Component {
  let from: string[] | undefined;
  let at = 0;
  let wrapped: string[] = [];
  return {
    render(width) {
      const now = lines(); // the same array until a read changes it
      if (now !== from || width !== at) [from, at, wrapped] = [now, width, now.flatMap((l) => (l ? wrapTextWithAnsi(" " + l, width) : [""]))];
      return wrapped;
    },
    invalidate() {
      from = undefined;
    },
  };
}

/**
 * The full-size overlay: a scrolled window over the content and a steer line.
 * It follows the end until scrolled up; End (or scrolling to the end) resumes.
 */
class OverlayFrame implements Component {
  private top: number | undefined; // first content line shown; undefined follows the end
  private width = 80; // of the last render
  readonly input = new Input({ prompt: "› " });
  private readonly tui: TUI;
  private readonly head: Component;
  private readonly content: Component;

  constructor(tui: TUI, head: Component, content: Component) {
    this.tui = tui;
    this.head = head;
    this.content = content;
    this.input.focused = true;
  }

  private window() {
    return Math.max(1, this.tui.terminal.rows - 2);
  }

  private scroll(by: number | "end") {
    const size = this.window();
    const last = Math.max(0, this.content.render(this.width).length - size);
    const top = by === "end" ? last : Math.max(0, Math.min(last, (this.top ?? last) + by));
    this.top = top >= last ? undefined : top;
    this.tui.requestRender();
  }

  render(width: number) {
    this.width = width;
    const size = this.window();
    const lines = this.content.render(width);
    const last = Math.max(0, lines.length - size);
    const top = Math.min(this.top ?? last, last);
    const shown = lines.slice(top, top + size);
    const bottom = this.input.render(width);
    // Paused: how much is below, so new output is visible without moving the view.
    const below = lines.length - top - shown.length;
    const head = (this.head.render(width)[0] ?? "") + (this.top !== undefined && below > 0 ? `  ↓ ${below} below · End` : "");
    while (shown.length < size) shown.push("");
    return [head, ...shown, ...bottom].map((l) => truncateToWidth(l, width));
  }

  handleInput(data: string) {
    const page = this.window() - 1;
    if (matchesKey(data, "pageUp")) this.scroll(-page);
    else if (matchesKey(data, "pageDown")) this.scroll(page);
    else if (matchesKey(data, "home")) this.scroll(-Infinity);
    else if (matchesKey(data, "end")) this.scroll("end");
    else {
      this.input.handleInput(data);
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scroll(event.wheelDelta);
    return { handled: true };
  }

  invalidate() {
    this.content.invalidate();
  }
}

export interface Viewer {
  /** The id of the item on screen, if any. */
  active(): string | undefined;
  /** Shows the item in the chat area, in place of the main chat or another item. */
  open(item: Item): void;
  /** Back to the main chat. Releases the item's file watcher. Safe to call twice. */
  close(): void;
  /** Esc closes an open item; true when consumed. */
  handleKey(data: string): boolean;
  /** Editor text while an item is open: its steer, echoed in the viewer. */
  steer(text: string): void;
  /** Whether the viewer is an overlay, which owns the arrow keys. */
  overlay(): boolean;
}

const scrollToEnd = (t: TUI) => (t as { scrollToBottom?: () => void }).scrollToBottom?.();

export function createViewer(ctx: ExtensionContext, tui: () => TUI | undefined): Viewer {
  let open:
    | {
        id: string;
        content: Container;
        release: () => void;
        frame?: OverlayFrame;
      }
    | undefined;

  const render = () => tui()?.requestRender();

  const echo = (component: Component) => {
    open?.content.addChild(component);
    render();
  };
  // Runs a producer's steer; a throw or rejection is shown in the viewer.
  const attempt = (what: string, run: () => void | Promise<void>) => {
    const failed = (e: unknown) => echo(new Text(ctx.ui.theme.fg("error", ` ${what} failed: ${oneLine((e as Error)?.message ?? e)}`), 0, 0));
    try {
      void Promise.resolve(run()).catch(failed);
    } catch (e) {
      failed(e);
    }
  };

  const viewer: Viewer = {
    active: () => open?.id,
    overlay: () => !!open?.frame,

    open(item) {
      viewer.close();
      const t = tui();
      if (!t) return;
      const content = new Container();
      const head = header(ctx, item.id);
      let stopWatch = () => {};
      let body: Component;
      if ("log" in item.view) {
        const path = item.view.log;
        const source = logSource(path);
        // Reads happen here, never in render: on open and when the file changes.
        const read = () => void (source.read() && render());
        source.read();
        watchFile(path, { interval: LOG_POLL_MS }, read);
        stopWatch = () => unwatchFile(path, read);
        body = logView(source.lines);
      } else {
        try {
          const transcript = item.view.transcript(t, ctx.ui) as Component & { dispose?(): void };
          body = transcript;
          stopWatch = () => transcript.dispose?.(); // a transcript's dispose, if it has one, runs on close
        } catch (e) {
          body = new Text(ctx.ui.theme.fg("error", ` transcript failed: ${oneLine((e as Error)?.message ?? e)}`), 0, 0);
        }
      }
      content.addChild(body);

      // Fullscreen only: regular mode has no scroll view, so follow, pause and End need the overlay.
      const found = isViewportTUI(t) ? findChat(t) : undefined;
      if (found) {
        // The chat-area swap: main-session output keeps going to the detached chat.
        const { chat } = found;
        const shown = new Container();
        // Pi invalidates every component after a mode switch (switchTuiMode). In regular mode
        // the swap cannot follow or pause, so the item moves to the overlay. The reverse cannot
        // happen: Pi refuses to switch mode while an overlay is open.
        shown.invalidate = () => {
          Container.prototype.invalidate.call(shown);
          if (isViewportTUI(t)) return;
          queueMicrotask(() => {
            const again = fleet().get(item.id);
            if (open?.content === content && again) viewer.open(again);
          });
        };
        shown.addChild(head);
        shown.addChild(content);
        const kids = found.parent.children;
        kids[kids.indexOf(chat)] = shown;
        open = {
          id: item.id,
          content,
          release: () => {
            stopWatch();
            // Put the chat back where the frame is now; if the frame is gone, into the chat's slot.
            const doc = (t as unknown as Container).children?.[0];
            const now = doc instanceof Container ? doc.children : kids;
            const i = now.indexOf(shown);
            if (i >= 0) now[i] = chat;
            else if (!now.includes(chat)) now.splice(Math.min(2, now.length), now.length === 3 ? 1 : 0, chat);
            (doc ?? found.parent).invalidate();
            scrollToEnd(t);
          },
        };
        found.parent.invalidate();
        scrollToEnd(t);
      } else {
        let done: (() => void) | undefined;
        const state: NonNullable<typeof open> = { id: item.id, content, release: () => (stopWatch(), done?.()) };
        open = state;
        ctx.ui.custom<void>(
          (overlayTui, _theme, _keys, finish) => {
            done = () => finish();
            const frame = new OverlayFrame(overlayTui, head, content);
            frame.input.onSubmit = (text) => {
              frame.input.setValue("");
              if (text.trim()) viewer.steer(text);
            };
            state.frame = frame;
            return frame;
          },
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
        ).catch(() => {
          // No overlay: nothing is open.
          stopWatch();
          if (open === state) open = undefined;
          fleet().viewing = viewer.active();
          render();
        });
      }
      fleet().viewing = item.id;
      render();
    },

    close() {
      if (!open) return;
      const { release } = open;
      open = undefined;
      fleet().viewing = undefined;
      release();
      render();
    },

    handleKey(data) {
      if (!open || !matchesKey(data, "escape")) return false;
      viewer.close();
      return true;
    },

    steer(text) {
      if (!open) return;
      const item = fleet().get(open.id);
      if (!item) {
        echo(new Text(ctx.ui.theme.fg("warning", " This item finished and was removed. Esc returns to the main chat."), 0, 0));
        return;
      }
      if (!item.steer) {
        echo(new Text(ctx.ui.theme.fg("warning", ` ${oneLine(item.kind)} ${oneLine(item.label)} takes no steering. Esc returns to the main chat.`), 0, 0));
        return;
      }
      if (!("showsSteers" in item.view && item.view.showsSteers)) echo(new UserMessageComponent(text, getMarkdownTheme()));
      attempt("steer", () => item.steer!(text));
    },
  };
  return viewer;
}
