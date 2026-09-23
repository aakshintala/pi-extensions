# fleet

FleetView: one list below the editor of all background work (agents, shell jobs and monitors) that other rig extensions register. Opening a row shows that item in the viewer. It also delivers their notices to the model. Spec: #29.

- The first row is the main session. Every item follows, and nested items are indented under their parent.
- Each row shows kind, label, running time and the latest activity. A finished row shows its status and result.
- A finished item leaves 30 s after it finishes. While it is selected, open in the viewer or has a running item under it, it stays, and the 30 s count from when that ends. Sending a prompt removes nothing.
- FleetView shows at most 6 lines. A `… N more` line counts the hidden rows, and the list scrolls to keep the selection visible.
- FleetView is hidden when nothing is registered.
- Terminal control sequences are stripped from every row. A row whose activity line throws shows `activity failed`.

## Viewer

- Enter or a click on a row shows that item in place of the chat. `●` marks the item on screen, and focus stays on its row (`›`).
- Up, Down and Enter on another row switch straight to it. Enter on `main` returns to the chat, with focus on `main`.
- Esc in FleetView returns to the prompt with the item still open, so typing steers it. A second Esc closes it.
- A shell job or monitor shows its log file, read as it grows, with colours kept and other control sequences stripped. An agent shows its transcript.
- Main-session output keeps going to the chat while you view an item, so you see it when you return.
- The viewer follows new output. Scrolling up pauses it, and End jumps back to the end and follows again.
- What you type while viewing an agent steers it and shows in the viewer, echoed by the viewer unless the item's transcript shows its steers itself (`showsSteers`). Other items take no steering. Slash commands still go to Pi; nothing else reaches the main session.
- The viewer stays open when its item finishes, and closes once the item is removed.
- The chat swap reaches into Pi's layout, and only fullscreen mode has the scroll view it needs. In regular mode, or if Pi is not version 0.87.1 or its layout differs, the viewer opens as a full-size overlay instead. Switching to regular mode while an item is swapped in moves it to the overlay. The overlay has its own steer line, PageUp, PageDown, Home, End and the mouse wheel scroll it, and while scrolled up its header counts the lines below.
- A log shows at most its last 2,000 lines. Each read takes at most 1 MiB, and a line says how many bytes it skipped.

## Notices

- Each notice shows in the chat as one themed line: `✓ agent scout · done 5s · found 3 files`.
- A failed (`✗`) or stopped (`■`) notice shows the whole error or reason under that line, with nothing to expand.
- A notice that arrives while the session is idle starts a turn. One that arrives during a turn joins it at the next step, so notices that arrive together share one turn.

## Ending with work running

Applies only to runs without the UI, which includes every child session.

- When the run is about to end with items it owns still running or queued, the model gets one message listing them (kind, label, ID, status, running time), and the run continues.
- After that, the run waits for each remaining item and continues with its notice, until none is left. The wait has no time limit.
- Switching or forking the session ends the wait. A plain abort does not, because Pi reports no event for it: stop the items the session owns, or dispose the session through its shutdown path.

Interactive sessions end their runs as usual: their work keeps running and its notices start new turns.

## Ctrl+B

Ctrl+B moves every running foreground command, such as a shell command, into the background. While one can be moved, `ctrl+b to run in background` shows under the editor, as one of FleetView's 6 lines.

Ctrl+B works only while Pi's editor has focus: a picker, dialog or overlay keeps the key. At a stop confirmation it cancels, like any other key.

Pi binds Ctrl+B to cursor left by default. To free it, add this to `keybindings.json` in Pi's agent directory:

```json
"tui.editor.cursorLeft": ["left"]
```

Until then Ctrl+B keeps moving the cursor, the hint never shows, and a warning names the line to add. It shows at startup, or at the next key once a `/reload` blocks Ctrl+B again, and never twice in a row.

## Keys

| Key | When | Does |
|---|---|---|
| Down or Left | Empty prompt | Focuses FleetView |
| Up / Down | FleetView focused | Moves the selection |
| Enter | FleetView focused | Opens the selected row |
| Esc | FleetView focused | Returns to the prompt; an open item stays open |
| Click | Fullscreen mode | Opens the row, like Enter |
| Esc | Viewing an item, at the prompt | Returns to the chat |
| Ctrl+Q, then y | Viewing an item | Stops it. Any other key cancels |
| End | Viewing an item | Jumps to the end and follows again |
| Ctrl+B | A foreground command runs | Moves every foreground command into the background |

Typing at a non-empty prompt is never captured.

## Tools, commands and settings

None.

## Producer interface

Other extensions import the registry from `shared/fleet` and never draw UI. It lives on a `globalThis` symbol, so it is one instance however Pi loads each extension.

```ts
import { fleet } from "../../shared/fleet/index.ts";

fleet().register({
  id: "job-1",                    // any id but "main", which is the main session's row
  owner: ctx.sessionManager.getSessionId(), // the session that started it: gets its notices, waits for it
  kind: "shell",                  // "agent", "shell" or "monitor"
  label: "npm test",
  parentId: "agent-1",            // optional: shows the row under that item
  activity: () => lastLine,       // required: the row's latest activity, read on every render
  view: { log: logPath },         // required: a log file, or { transcript: (tui, ui) => component, showsSteers? };
                                  // a transcript is built on each open, and its dispose(), if any, runs on close
  stop: () => child.kill(),       // required
  steer: undefined,               // optional, agents only
});
fleet().update("job-1");                              // redraw the activity line
fleet().update("job-1", { label: "npm test --watch" }); // ignored once finished
fleet().finish("job-1", "completed", "12 tests passed");  // notice: a default line built from the item
fleet().finish("job-1", "failed", "exit 1\nError: boom",  // the user's summary: a failure's error, in full
  "shell job-1 failed (exit 1). Log: /tmp/job-1.log");    // the model's notice, in your own wording
fleet().finish("job-1", "completed", "done", null);       // no notice: the model already has the result
fleet().notify("job-1", "build 42 passed");              // a notice while running, such as a monitor line

const end = fleet().foreground(owner, () => moveToBackground()); // Ctrl+B calls this; dropped if it throws
end(); // once the command ends or is backgrounded; the owner's session shutdown drops it too
```

A notice goes to the owner session only. One sent before that session attaches is held until it does, up to the latest 50. Once the session shuts down, or its delivery throws because it was disposed, its notices are dropped.
