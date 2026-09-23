// The ask_user bottom panel: one option list per question, the last row an
// inline free-text field; a review tab (answers + note) when there are 2+ questions.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type Question = { question: string; header: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };
export type Answer = { labels: string[]; text?: string };
export type Outcome = { cancelled: true } | { cancelled: false; answers: (Answer | null)[]; note?: string };

const TEXT_ROW = "Type your own answer";

export function panel(questions: Question[], theme: Theme, render: () => void, done: (o: Outcome) => void): Component {
  const n = questions.length;
  const tabs = n > 1 ? n + 1 : 1; // the last tab is review
  const input = (placeholder: string) => new Input({ prompt: "", placeholder, placeholderStyle: (s) => theme.fg("dim", s) });
  const state = questions.map(() => ({ cursor: 0, picked: new Set<number>(), chosen: null as Answer | null, input: input(TEXT_ROW) }));
  const note = input("Add a note to the agent (optional)");
  let tab = 0;
  let row = n; // review cursor: 0..n-1 answers, n note, n+1 submit

  const opts = (i: number) => questions[i].options ?? [];
  const text = (i: number) => state[i].input.getValue().trim();
  const answer = (i: number): Answer | null => {
    if (!questions[i].multiSelect) return state[i].chosen;
    const labels = opts(i).filter((_, k) => state[i].picked.has(k)).map((o) => o.label);
    return labels.length || text(i) ? { labels, ...(text(i) ? { text: text(i) } : {}) } : null;
  };
  const show = (a: Answer | null) => (a ? [...a.labels, ...(a.text ? [`"${a.text}"`] : [])].join(", ") : "skipped");
  const finish = () => {
    const t = note.getValue().trim();
    done({ cancelled: false, answers: questions.map((_, i) => answer(i)), ...(t ? { note: t } : {}) });
  };
  const go = (to: number) => {
    tab = (to + tabs) % tabs;
    if (tab === n) row = n;
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
    } else if (onText) s.input.handleInput(data);
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
  const editing = () => (tab === n ? row === n && note.getValue() : state[tab].cursor === opts(tab).length && state[tab].input.getValue());

  const field = (inp: Input, focused: boolean, width: number, placeholder: string) => {
    inp.focused = focused;
    if (focused) return inp.render(width)[0];
    return inp.getValue() || theme.fg("dim", placeholder);
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
    lines.push(lead + field(s.input, s.cursor === k, width - visibleWidth(lead), TEXT_ROW) + tick);
    const choose = q.multiSelect ? "Space toggle · Enter confirm" : "Enter choose";
    lines.push("", theme.fg("dim", `  ↑↓ move · ${choose}${n > 1 ? " · Tab/←→ switch" : ""} · Esc cancel`));
    return lines;
  }

  function reviewLines(width: number): string[] {
    const lines = [theme.bold("Review your answers"), ""];
    questions.forEach((q, i) => lines.push(`${pointer(row === i)}${theme.fg("muted", `${q.header}:`)} ${show(answer(i))}`));
    lines.push("", pointer(row === n) + field(note, row === n, width - 2, "Add a note to the agent (optional)"));
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
      return [...(n > 1 ? [` ${bar.join(" ")}`, ""] : []), ...body].map((l) => truncateToWidth(l, width));
    },
    invalidate() {},
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
