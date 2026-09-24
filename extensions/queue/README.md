# queue

A visible, editable message queue, replacing `pi-queue-steer`. It keeps Pi's own
editor: nothing is replaced.

## Queuing

Messages you submit while the agent works are held here instead of in Pi's
native queue:

- Enter queues a steering message, delivered at the next turn boundary. A
  `bash` command running in the foreground moves to the background, so that
  boundary comes at once (see `extensions/jobs`).
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

Each group is delivered first in, first out, draining every ready row at the
boundary at once. Skill commands in a queued message are
expanded on delivery. Input from RPC drivers and extensions goes straight to Pi. While the fleet viewer shows an item, what you type steers that item instead
(slash commands still queue here).

## Widget

Above the editor and above TODOs and other widgets: "Steering" and "Follow-ups" groups, each row on one line. Hidden when nothing is queued.

## Keys

- Option+Up: take the newest queued row out of the queue and load it into the editor. The original cannot be sent while you edit it. Press it again to put the current edit back and take the previous row. Option+Down moves the other way.
- Enter: submit the edited row once, in its original steering or follow-up lane. Your previous draft returns to the editor. Option+X deletes the retrieved row.
- Esc: abort the current turn. If you were editing, it puts the edited row back first. Queued steering starts a new turn as soon as the abort settles, or immediately if already idle; follow-ups run afterward.

The keys are read only while Pi's editor has focus. With nothing queued,
Option+Up keeps Pi's own behaviour.

Known limit: while you edit a row, Enter on `/compact`, `/reload` or an
extension command saves it in place, and it runs when delivered. Other Pi
built-in commands (such as `/model` or `/tree`) still run at once, because Pi
handles them before any extension sees them. The retrieved row stays in the editor
until you submit it or press Esc. Reloading while you edit saves the current text as a queued row and restores your earlier draft.

## Commands, tools, settings

None. The queue is cleared on session switch.

## Upstream

Behaviour follows [`@tmustier/pi-queue-steer`](https://github.com/tmustier/pi-queue-steer)
0.2.0 (MIT, Thomas Mustier). Its reload-survival approach is adapted (rows are
saved to a `rig.queue` session entry, restored only by the reload that wrote
it); no code is copied.
