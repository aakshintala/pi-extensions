# todo

A TODO list the agent keeps while it works, replacing `pi-tasks`. The list is
stored in the session (in `todo_write` results), so it survives resume and
follows the branch you are on. Nothing is written to the repository.

## Tool

- `todo_write({ todos: [{ text, status }] })`: replaces the whole list.
  `status` is `pending`, `in_progress` or `completed`. An empty list clears it.
  Returns counts by status.

## Widget

When the list has items, one row above the editor shows the current step and
counts (`◼ Running tests · 2 pending · 1 done`). Click it in fullscreen mode or
use `/todos` to expand or collapse the list inline. Expanded items use ✔ done,
◼ in progress and ◻ pending; more than 7 open items end in `… N more`.
Newlines become spaces and long text is truncated. Updates keep the widget to
one row while collapsed.

The widget is hidden when the list is empty. A fully completed list is hidden
after your next prompt; `/todos` can show it again. Subagent sessions (those
holding the `rig.subagent` entry) keep their own list and draw no widget.

## Reminder

When a turn (everything since your last prompt) makes no tool call while an item is `in_progress`, the next
request carries a short reminder naming those items. It is never saved to the
session.

## Commands, keys, settings

- `/todos`: expand or collapse the widget (also works without mouse support).
- No keys or settings.
