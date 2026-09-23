# pi-rig

Customized Pi extensions maintained as a lightweight monorepo. Every extension is rebuilt here from a behaviour spec; vendored upstream source is kept for reference and never loaded by Pi.

## Install

```sh
pi install /path/to/pi-rig
```

## Extensions

| Extension | What it is for | Spec |
|---|---|---|
| [ponytail](extensions/ponytail/README.md) | Always-on guidance to build the simplest working solution, plus the `ponytail-audit` skill | [#37](https://github.com/aakshintala/pi-rig/issues/37) |
| [status](extensions/status/README.md) | Quota headroom from QuotaBar.app via `get_quotas` and `/quota` | [#38](https://github.com/aakshintala/pi-rig/issues/38) |
| [rig](extensions/rig/README.md) | `/rig` settings menu over every extension's `rig.json` section | [#32](https://github.com/aakshintala/pi-rig/issues/32) |
| [fleet](extensions/fleet/README.md) | FleetView: one list below the editor of all running background work | [#29](https://github.com/aakshintala/pi-rig/issues/29) |
| [tool-display](extensions/tool-display/README.md) | Claude Code-style call lines, collapsed results and edit diffs for the built-in `read`, `edit` and `write` | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [todo](extensions/todo/README.md) | A TODO list the agent keeps while it works, via `todo_write` and a widget above the editor | [#28](https://github.com/aakshintala/pi-rig/issues/28) |
| [search](extensions/search/README.md) | `grep` and `find` served by the FFF native index, falling back to Pi's built-ins | [#35](https://github.com/aakshintala/pi-rig/issues/35) |
