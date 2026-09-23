# fleet

FleetView: one list below the editor of all background work (agents, shell jobs and monitors) that other rig extensions register. Spec: #29.

- The first row is the main session. Every item follows, and nested items are indented under their parent.
- Each row shows kind, label, running time and the latest activity. A finished row shows its status and result.
- Finished items stay until you send your next prompt.
- FleetView shows at most 6 lines. A `… N more` line counts the hidden rows, and the list scrolls to keep the selection visible.
- FleetView is hidden when nothing is registered.
- Terminal control sequences are stripped from every row. A row whose activity line throws shows `activity failed`.

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
fleet().finish("job-1", "completed", "12 tests passed");
```
