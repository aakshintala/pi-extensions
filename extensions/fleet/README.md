# fleet

FleetView: one list below the editor of all background work (agents, shell jobs and monitors) that other rig extensions register. Spec: #29.

- The first row is the main session. Every item follows, and nested items are indented under their parent.
- Each row shows kind, label, running time and the latest activity. A finished row shows its status and result.
- Finished items stay until you send your next prompt.
- FleetView shows at most 6 lines. A `… N more` line counts the hidden rows, and the list scrolls to keep the selection visible.
- FleetView is hidden when nothing is registered.
- Terminal control sequences are stripped from every row.

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

fleet().register({ id, kind: "shell", label: "npm test", parentId, activity: () => lastLine, stop, view: { log: path } });
fleet().update(id);                       // redraw; or update(id, { label, status, parentId })
fleet().finish(id, "completed", "12 tests passed");
```
