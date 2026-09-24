// The ask_user bottom panel: one option list per question, the last row a free-text
// field; a review tab (answers + note) when there are 2+ questions.
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { oneLine } from "../../shared/text/index.ts";

export type Question = { question: string; header: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };
type Answer = { labels: string[]; text?: string };
export type Outcome = { cancelled: true } | { cancelled: false; answers: (Answer | null)[]; note?: string };

const TEXT_ROW = "Type your own answer";
const NOTE_ROW = "Add a note to the agent (optional)";

/** Labels and typed text, comma-joined; "skipped" for no answer. */
export const answerText = (a: Answer | null): string =>
  a ? [...a.labels, ...(a.text ? [`"${a.text}"`] : [])].join(", ") : "skipped";

export function panel(tui: TUI, questions: Question[], theme: Theme, render: () => void, done: (o: Outcome) => void): Component {
  const n = questions.length;
  const tabs = n > 1 ? n + 1 : 1; // the last tab is review
  // The free-text fields are Pi's own editor: long answers wrap and the box grows,
  // just like the regular editor. No autocomplete provider, so no completions fire.
  // Enter never reaches the editor (the panel confirms first) and with disableSubmit
  // it could not submit anyway, so answers stay one line (see `text`).
  const editorTheme = {
    borderColor: (s: string) => theme.fg("border", s),
    selectList: {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("muted", s),
    },
  };
  const input = () => {
    const editor = new Editor(tui, editorTheme);
    editor.disableSubmit = true;
    return editor;
  };
  const state = questions.map(() => ({ cursor: 0, picked: new Set<number>(), chosen: null as Answer | null, editor: input() }));
  const note = input();
  const border = new DynamicBorder((s: string) => theme.fg("border", s));
  let tab = 0;
  let row = n + 1; // review cursor: 0..n-1 answers, n note, n+1 submit; review opens on Submit

  const opts = (i: number) => questions[i].options ?? [];
  const text = (i: number) => oneLine(state[i].editor.getText());
  const answer = (i: number): Answer | null => {
    if (!questions[i].multiSelect) return state[i].chosen;
    const labels = opts(i).filter((_, k) => state[i].picked.has(k)).map((o) => o.label);
    return labels.length || text(i) ? { labels, ...(text(i) ? { text: text(i) } : {}) } : null;
  };
  const finish = () => {
    const t = oneLine(note.getText());
    done({ cancelled: false, answers: questions.map((_, i) => answer(i)), ...(t ? { note: t } : {}) });
  };
  const go = (to: number) => {
    tab = (to + tabs) % tabs;
    if (tab === n) row = n + 1;
  };
  const advance = () => (n === 1 ? finish() : go(tab + 1));

  function questionKey(data: string) {
    const kb = getKeybindings();
    const s = state[tab];
    const rows = opts(tab).length + 1;
    const onText = s.cursor === rows - 1;
    if (kb.matches(data, "tui.select.up")) s.cursor = (s.cursor + rows - 1) % rows;
    else if (kb.matches(data, "tui.select.down")) s.cursor = (s.cursor + 1) % rows;
    else if (kb.matches(data, "tui.select.confirm")) {
      if (questions[tab].multiSelect) return advance();
      if (!onText) s.chosen = { labels: [opts(tab)[s.cursor].label] };
      else if (text(tab)) s.chosen = { labels: [], text: text(tab) };
      else if (n > 1) return; // with one question, Enter on the empty row skips it
      advance();
    } else if (onText) s.editor.handleInput(data);
    else if (questions[tab].multiSelect && matchesKey(data, "space")) {
      s.picked.has(s.cursor) ? s.picked.delete(s.cursor) : s.picked.add(s.cursor);
    }
  }

  function reviewKey(data: string) {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) row = (row + n + 1) % (n + 2);
    else if (kb.matches(data, "tui.select.down")) row = (row + 1) % (n + 2);
    else if (kb.matches(data, "tui.select.confirm")) row < n ? go(row) : row === n ? (row = n + 1) : finish();
    else if (row === n) note.handleInput(data);
  }

  // Left/Right move the caret while the focused text field holds text.
  const editing = () => (tab === n ? row === n && note.getText() : state[tab].cursor === opts(tab).length && state[tab].editor.getText());

  // A text field: the editor's wrapped lines inline with the lead, so the text
  // starts on the option's own row and the box grows below it. Pi's Editor always
  // draws its top/bottom borders; the panel uses none, so they are dropped here.
  // Unfocused, a field with text is one truncated line; empty, a dim hint.
  const field = (editor: Editor, focused: boolean, lead: string, width: number, placeholder: string) => {
    editor.focused = focused;
    const v = oneLine(editor.getText());
    if (!focused) return [lead + (v ? truncateToWidth(v, width - visibleWidth(lead)) : theme.fg("dim", placeholder))];
    const indent = visibleWidth(lead);
    const rendered = editor.render(Math.max(1, width - indent));
    const body = (rendered.length >= 2 ? rendered.slice(1, -1) : rendered).map((l) => l.trimEnd());
    const pad = " ".repeat(indent);
    return body.map((l, i) => (i === 0 ? lead + l : pad + l));
  };
  const pointer = (on: boolean) => (on ? theme.fg("accent", "→ ") : "  ");

  function questionLines(width: number): string[] {
    const q = questions[tab];
    const s = state[tab];
    const lines = [...wrapTextWithAnsi(theme.bold(q.question), width), ""];
    const chosen = s.chosen?.labels[0];
    opts(tab).forEach((o, k) => {
      const mark = q.multiSelect ? (s.picked.has(k) ? "[x] " : "[ ] ") : `${k + 1}. `;
      const tick = !q.multiSelect && chosen === o.label ? theme.fg("success", " ✓") : "";
      const label = s.cursor === k ? theme.fg("accent", o.label) : o.label;
      lines.push(pointer(s.cursor === k) + mark + label + tick);
      if (o.description) lines.push(...wrapTextWithAnsi(theme.fg("muted", o.description), width - 6).map((l) => `      ${l}`));
    });
    const k = opts(tab).length;
    const lead = pointer(s.cursor === k) + (q.multiSelect ? "    " : `${k + 1}. `);
    const tick = !q.multiSelect && s.chosen?.text ? theme.fg("success", " ✓") : "";
    if (s.cursor === k) {
      for (const l of field(s.editor, true, lead, width, TEXT_ROW)) lines.push(l);
    } else {
      const [line] = field(s.editor, false, lead, width, TEXT_ROW);
      lines.push(line + tick);
    }
    const choose = q.multiSelect ? "Space toggle · Enter confirm" : "Enter choose";
    lines.push("", theme.fg("dim", `  ↑↓ move · ${choose}${n > 1 ? " · Tab/←→ switch" : ""} · Esc cancel`));
    return lines;
  }

  function reviewLines(width: number): string[] {
    const lines = [theme.bold("Review your answers"), ""];
    questions.forEach((q, i) => lines.push(`${pointer(row === i)}${theme.fg("muted", `${q.header}:`)} ${answerText(answer(i))}`));
    lines.push("");
    if (row === n) {
      for (const l of field(note, true, pointer(true), width, NOTE_ROW)) lines.push(l);
    } else {
      const [line] = field(note, false, pointer(false), width, NOTE_ROW);
      lines.push(line);
    }
    lines.push(pointer(row === n + 1) + theme.fg(row === n + 1 ? "accent" : "text", "Submit answers"));
    lines.push("", theme.fg("dim", "  Enter on an answer to change it · Tab/←→ switch · Esc cancel"));
    return lines;
  }

  return {
    render(width) {
      const bar = [...questions.map((q, i) => (answer(i) ? `${q.header} ✓` : q.header)), "Review"].map((label, i) =>
        i === tab ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", ` ${label} `),
      );
      const body = tab === n ? reviewLines(width) : questionLines(width);
      // The panel draws its own border: bare custom components render borderless.
      const framed = [...border.render(width), ...(n > 1 ? [` ${bar.join(" ")}`, ""] : []), ...body, theme.fg("border", "─".repeat(width))];
      return framed.map((l) => truncateToWidth(l, width));
    },
    invalidate() {
      border.invalidate();
    },
    handleInput(data) {
      if (getKeybindings().matches(data, "tui.select.cancel")) return done({ cancelled: true });
      const tabKey = matchesKey(data, "tab") || matchesKey(data, "shift+tab");
      if (n === 1 && tabKey) return; // no other tab, and never a literal tab in the text row
      if (n > 1 && (matchesKey(data, "tab") || (matchesKey(data, "right") && !editing()))) go(tab + 1);
      else if (n > 1 && (matchesKey(data, "shift+tab") || (matchesKey(data, "left") && !editing()))) go(tab - 1);
      else if (tab === n) reviewKey(data);
      else questionKey(data);
      render();
    },
  };
}
