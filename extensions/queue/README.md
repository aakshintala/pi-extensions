# queue

A visible, editable message queue, replacing `pi-queue-steer`. It keeps Pi's own
editor: nothing is replaced.

## Queuing

Messages you submit while the agent works are held here instead of in Pi's
native queue:

- Enter queues a steering message, delivered at the next turn boundary.
- Option+Enter queues a follow-up, delivered after the run.
- `/compact`, `/compact <instructions>` and `/reload` become command rows (⚙).
  They run once the agent is idle, in order, and rows queued after them wait.
  A `/compact` with nothing to compact shows a notice and moves on; a failed one
  stays queued, paused, with the reason. Pi 0.87.1 still prints its own red
  "Compaction failed: Nothing to compact" line, which no public API can
  prevent. Rows behind a `/reload` survive it, and so does a draft Pi's
  `/reload` would clear. A queued `/reload` waits while a picker or the label
  editor has focus.
  Typed while the agent is idle, they run at once as usual.

Each group is delivered first in, first out, following Pi's `steeringMode` and
`followUpMode` (read at session start). Skill commands in a queued message are
expanded on delivery. Input from RPC drivers and extensions goes straight to Pi. While the fleet viewer shows an item, what you type steers that item instead
(slash commands still queue here).

## Widget

Above the editor: "Steering" and "Follow-ups" groups, each row on one line.
Hidden when nothing is queued.

## Keys

- Option+Up: load the most recent row into the editor; again to move up.
- Option+Down: move down.
- Enter: save the edit in place. Esc: cancel it. Option+X: delete the row.
- Your draft comes back when the edit ends. A row delivered while you edit it
  ends the edit with a notice.
- Esc while the agent works aborts as usual and pauses the queue with its rows
  intact. Your next submission, or Option+Up, resumes it.

The keys are read only while Pi's editor has focus. With nothing queued,
Option+Up keeps Pi's own behaviour.

Known limit: while you edit a row, Enter on `/compact`, `/reload` or an
extension command saves it in place, and it runs when delivered. Other Pi
built-in commands (such as `/model` or `/tree`) still run at once, because Pi
handles them before any extension sees them. The row is left unchanged and the
edit stays open until Esc.

## Commands, tools, settings

None. The queue is cleared on session switch.

## Upstream

Behaviour follows [`@tmustier/pi-queue-steer`](https://github.com/tmustier/pi-queue-steer)
0.2.0 (MIT, Thomas Mustier). Its reload-survival approach is adapted (rows are
saved to a `rig.queue` session entry, restored only by the reload that wrote
it); no code is copied.
