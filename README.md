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
| [fleet](extensions/fleet/README.md) | FleetView groups running shells, shows linked agent activity, clears finished work after 10 seconds, and provides a viewer, notices and Ctrl+B | [#29](https://github.com/aakshintala/pi-rig/issues/29) |
| [tool-display](extensions/tool-display/README.md) | Groups tool calls into static live summaries (Pi's editor owns the spinner); Ctrl+O or a click reveals errors, while built-in `read`, `edit` and `write` show call lines and edit diffs | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [working](extensions/working/README.md) | Shows a glimmering Thinking or Running tool label and elapsed time in Pi's editor border | [#40](https://github.com/aakshintala/pi-rig/issues/40) |
| [todo](extensions/todo/README.md) | `todo_write` keeps a TODO list; a compact row above the editor expands on click or `/todos` | [#28](https://github.com/aakshintala/pi-rig/issues/28) |
| [search](extensions/search/README.md) | `grep` and `find` served by the FFF native index, falling back to Pi's built-ins | [#35](https://github.com/aakshintala/pi-rig/issues/35) |
| [stamp](extensions/stamp/README.md) | One compact duration and completion-time line per settled agent run | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [ask-user](extensions/ask-user/README.md) | `ask_user`: questions in a bottom panel with inline free text | [#34](https://github.com/aakshintala/pi-rig/issues/34) |
| [queue](extensions/queue/README.md) | Steering and follow-ups above other widgets; retrieve a row to edit, or abort and send queued steering | [#39](https://github.com/aakshintala/pi-rig/issues/39) |
| [usage](extensions/usage/README.md) | `/usage`: cost and token usage across sessions, as a graph or a table per period | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [context](extensions/context/README.md) | `/context`: context usage map and injections inspector | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [clear](extensions/clear/README.md) | `/clear`: starts a new session, as `/new` does | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [theme](extensions/theme/README.md) | `/theme`: Pi's own theme picker with live preview | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [inline-skills](extensions/inline-skills/README.md) | `/skill-name` anywhere in a prompt loads that skill, with mid-prompt autocomplete | [#36](https://github.com/aakshintala/pi-rig/issues/36) |
| [subagents](extensions/subagents/README.md) | Background subagents via `subagent_spawn`, `subagent_message` and `subagent_stop`, nested up to a depth cap, optionally forked or in their own git worktree, with results pushed as notices and a transcript in the viewer | [#26](https://github.com/aakshintala/pi-rig/issues/26) |
| [jobs](extensions/jobs/README.md) | `bash` that moves long commands to the background, and `jobs` to list, wait on and stop them | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
| [monitor](extensions/monitor/README.md) | `monitor`: a watch command whose output lines reach the agent as rate-limited notices | [#30](https://github.com/aakshintala/pi-rig/issues/30) |
