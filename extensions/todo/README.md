# todo

A TODO list the agent keeps while it works, replacing `pi-tasks`. The list is
stored in the session (in `todo_write` results), so it survives resume and
follows the branch you are on. Nothing is written to the repository.

## Tool

- `todo_write({ todos: [{ text, status }] })`: replaces the whole list.
  `status` is `pending`, `in_progress` or `completed`. An empty list clears it.
  Returns counts by status.

## Widget

Above the editor: ✔ completed, ◼ in progress, ◻ pending. Completed items
collapse into one "✔ N done" line; more than 7 open items end in "… N more".
Each item is one row: newlines become spaces, control characters are dropped
and long text is truncated.
Hidden when the list is empty, and a fully completed list is hidden once you
send your next prompt. Subagent sessions (those holding the `rig.subagent`
entry) keep their own list and draw no widget.

## Reminder

When a turn (everything since your last prompt) makes no tool call while an item is `in_progress`, the next
request carries a short reminder naming those items. It is never saved to the
session.

## Commands, keys, settings

None.
