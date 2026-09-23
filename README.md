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
| [status](extensions/status/README.md) | Two-line footer (model, usage, context, git, quotas, speed), plus quota headroom via `get_quotas` and `/quota` | [#38](https://github.com/aakshintala/pi-rig/issues/38) |
| [rig](extensions/rig/README.md) | `/rig` settings menu over every extension's `rig.json` section | [#32](https://github.com/aakshintala/pi-rig/issues/32) |
| [fleet](extensions/fleet/README.md) | FleetView, a viewer, completion notices and Ctrl+B for all running background work | [#29](https://github.com/aakshintala/pi-rig/issues/29) |
| [tool-display](extensions/tool-display/README.md) | Groups each run of tool calls, across responses, into one live summary line (Ctrl+O or a click expands it), hides hidden thinking completely, and draws Claude Code-style call lines and edit diffs for the built-in `read`, `edit` and `write` | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [todo](extensions/todo/README.md) | A TODO list the agent keeps while it works, via `todo_write` and a widget above the editor | [#28](https://github.com/aakshintala/pi-rig/issues/28) |
| [search](extensions/search/README.md) | `grep` and `find` served by the FFF native index, falling back to Pi's built-ins | [#35](https://github.com/aakshintala/pi-rig/issues/35) |
| [stamp](extensions/stamp/README.md) | Timestamps, response timing, metadata and tool durations in the transcript; no row for tool-only responses | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [ask-user](extensions/ask-user/README.md) | `ask_user`: questions in a bottom panel with inline free text | [#34](https://github.com/aakshintala/pi-rig/issues/34) |
| [queue](extensions/queue/README.md) | Messages queued while the agent works, shown above the editor and editable in it | [#39](https://github.com/aakshintala/pi-rig/issues/39) |
| [usage](extensions/usage/README.md) | `/usage`: cost and token usage across sessions, as a graph or a table per period | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [context](extensions/context/README.md) | `/context`: context usage map and injections inspector | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [clear](extensions/clear/README.md) | `/clear`: starts a new session, as `/new` does | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [theme](extensions/theme/README.md) | `/theme`: Pi's own theme picker with live preview | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [inline-skills](extensions/inline-skills/README.md) | `/skill-name` anywhere in a prompt loads that skill, with mid-prompt autocomplete | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [subagents](extensions/subagents/README.md) | Background subagents via `subagent_spawn`, `subagent_message` and `subagent_stop`, nested up to a depth cap, optionally forked or in their own git worktree, with results pushed as notices and a transcript in the viewer | [#26](https://github.com/aakshintala/pi-rig/issues/26) |
| [jobs](extensions/jobs/README.md) | `bash` that moves long commands to the background, and `jobs` to list, wait on and stop them | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
| [monitor](extensions/monitor/README.md) | `monitor`: a watch command whose output lines reach the agent as rate-limited notices | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
