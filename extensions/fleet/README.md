# fleet

FleetView: one list below the editor of all background work (agents, shell jobs and monitors) that other rig extensions register. It also delivers their notices to the model. Spec: #29.

- The first row is the main session. Every item follows, and nested items are indented under their parent.
- Each row shows kind, label, running time and the latest activity. A finished row shows its status and result.
- Finished items stay until you send your next prompt.
- FleetView shows at most 6 lines. A `… N more` line counts the hidden rows, and the list scrolls to keep the selection visible.
- FleetView is hidden when nothing is registered.
- Terminal control sequences are stripped from every row. A row whose activity line throws shows `activity failed`.

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

## Keys

| Key | When | Does |
|---|---|---|
| Down or Left | Empty prompt | Focuses FleetView |
| Up / Down | FleetView focused | Moves the selection |
| Esc | FleetView focused | Returns to the prompt |
| Click | Fullscreen mode | Selects the row |

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
  view: { log: logPath },         // required: a log file, or { transcript: () => component }
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
```

A notice goes to the owner session only. One sent before that session attaches is held until it does. Once the session shuts down, or its delivery throws because it was disposed, its notices are dropped.
