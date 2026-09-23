# ask-user

`ask_user` asks the user one to four questions in a panel at the bottom of
the screen, with the transcript still visible above it. It replaces
`pi-ask-complete`.

## Tool

- `ask_user({ questions })`: each question has `question`, `header` (tab
  label, at most 12 characters), optional `options` (2 to 4, each a `label`
  and optional `description`) and optional `multiSelect`.
- Result: one line per question, `header: labels`, `header: "typed"` or
  `header: skipped`, then `note: ...` when given. Esc returns `cancelled`.
- Model text (questions, headers, labels) is shown and returned as one plain
  line; a header wider than 12 columns is rejected. Aborting the turn closes
  the panel and returns `cancelled`.
- With no interactive UI (`pi -p`, RPC) the tool fails and tells the model to
  state its assumption and continue.
- Sessions holding the `rig.subagent` entry (#26) do not get the tool.

## Keys

| Key | Action |
|---|---|
| ↑ ↓ | Move between options |
| Enter | Choose (single-select) or confirm (multi-select) |
| Space | Toggle an option (multi-select) |
| typing | The last row, "Type your own answer", is an inline text field |
| Tab, Shift+Tab, ← → | Switch question; moving on unanswered skips it |
| Esc | Cancel the whole panel |

One question submits as soon as it is answered; Enter on its empty text row
skips it. Two or more end on a review tab that lists every answer (Enter on
one jumps back to it) and takes an optional note to the agent.

## `rig.json` settings

None.
