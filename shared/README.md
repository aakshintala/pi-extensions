# Shared libraries live here.

Helpers shared by two or more extensions. Extract on second use, never
speculatively — the first use stays inside its extension.

- Plain TypeScript modules, no side effects on import.
- No pi lifecycle handling here: extensions own registration, resource
  startup, and `session_shutdown` cleanup.
- Same dependency rule as `extensions/`: `node:` built-ins only.

## Modules

### `settings/`

The rig's settings file, `rig.json` in Pi's agent directory (spec #32).
One instance per process, kept on a `globalThis` symbol.

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";

const settings = rigSettings(getAgentDir()).declare("jobs", [
  { key: "maxJobs", type: "integer", min: 1, max: 64, default: 16, description: "Most jobs at once" },
]);
settings.get("maxJobs");
settings.onChange((key, value) => { /* apply */ });
```

- Types: `boolean`, `integer` (optional `min`/`max`), `enum` (`values`).
  An `enum` is open with `other: { label, test }`: a string passing `test` is
  also valid, and warnings read "must be one of a, b or <label>". `/rig`
  cycles the named values plus the current other value, and `e` types one.
- Loading never throws: a bad value, unknown key or invalid JSON queues one
  warning and uses the default. `notifyWarnings(ui)` sends each once.
- `set`/`reset`, and `setMany` for several keys in one write, validate,
  re-read the file, change only the given keys, keep only non-default keys,
  and write atomically (temp file, then rename).
- There is one live section per name for the process. Redeclaring it (on
  `/reload`, or when an in-process subagent session runs the factory again)
  returns the same handle, takes the new settings, and re-reads and
  re-validates the file; listeners stay and hear every changed or added
  key, and each removed key with value `undefined`. A warning repeats only
  when its value changes, and a file that cannot be read keeps the current
  values.
  Unsubscribe with the function `onChange` returns on `session_shutdown`, or
  listeners pile up across sessions. There is no file watcher and no project
  file.
- `sections()` lists declared sections for the `/rig` menu, and
  `problem(setting, value)` returns why a value is invalid (or nothing).
- `/rig` itself is registered by `extensions/rig`, which also sends the
  load warnings at session start; other extensions need not call
  `notifyWarnings`.

### `tool-display/`

The rig's tool style (spec #40), Claude Code-like. Rig tools and the built-in
`read`/`edit`/`write` render through it, and runs of calls group into one line.

```ts
import { toolRenderers, plural } from "../../shared/tool-display/index.ts";

pi.registerTool({
  ...definition,
  ...toolRenderers({
    title: "Read",                                  // ⏺ Read(a.txt)
    arg: (args, cwd) => args.path,
    result: (result, args, expanded, theme) => ({ summary: "Read 3 lines", body: [] }), // ⎿ Read 3 lines
  }),
});
```

- `toolRenderers` sets `renderShell: "self"`; partial results draw nothing and
  errors always show as `⎿ Error: …`.
- Pieces for other layouts: `callLine`, `resultLines` (collapsed to 4 body
  lines, expanded capped at 200), `errorLines`, `unifiedDiff` (from old/new
  text, no file reads, skipped over 100,000 characters) and `diffBody`.
- Colours come only from theme keys; every line fits the width it is given.

**Groups** (#56). Give a tool a `summary` and consecutive calls to such tools in
one assistant message collapse into one live line, e.g. "Read 3 files, edited
2 files +442 −12 · 1 failed":

```ts
summary: { verb: "edited", one: "file", lines: (args) => ({ added, removed }) } // "edited N files +a −r"
summary: { verb: "updated", many: "todos" }                                     // no `one`: "updated todos"
```

- The first call draws the summary; the others draw nothing. Failed calls and
  calls with images always show. Ctrl+O (`context.expanded`) or a click on the
  group shows every call.
- A tool without `summary` (such as `ask_user`) is never grouped and splits a run,
  as does text between calls. Grouping is decided as calls render, in message
  order, so descriptors are not registered anywhere.
- Groups belong to a `ToolGroups`, one per session. `extensions/tool-display`
  creates it, feeds it from Pi's events and owns its spinner timer. To group a
  transcript built from saved messages, call `track(assistantMessage)` and
  `settle(toolCallId, isError, result)` for each result in order, then `endRun()`;
  `reset()` forgets the session's calls. `outcomeOf(isError, result)` classifies a
  result: an error ending in Pi's `Operation aborted` or `Command aborted` is
  `cancelled`, any other error `error`. Calls with no result in an aborted turn
  are `cancelled`; a returned error is never recast.
- Call ids can repeat across sessions; each session indexes and removes only its
  own, and a renderer picks the session holding the call's arguments.
- `summaryText(theme, calls, thought)` builds the text; `thought` starts it with
  "thought ·". Groups set it when their message has thinking (#57).

### `text/`

`oneLine(s)` turns model or producer text into one plain line for the screen:
7- and 8-bit CSI, OSC, DCS, SOS, PM and APC sequences are removed, and control
characters and newlines collapse to a space. Used by `extensions/todo` and
`extensions/fleet`.

`keepSgr(s)` removes the same sequences except SGR (colours and styles), for
text shown with its colours. `unfinished(s)` gives where a sequence cut off by
the end of `s` starts, for text that arrives in pieces. Both are used by the
fleet viewer's log.

### `fleet/`

The background-work registry (#29). Items carry an `owner` session id.
`finish(id, status, result, notice?)` and `notify(id, text)` send notices to the
owner's fleet extension. That extension delivers them, and it keeps a run
without the UI alive until its items return. A `finish` with no notice sends a
default line; a `null` notice sends nothing. See `extensions/fleet/README.md`.

`fleet().viewing` is the item the fleet viewer shows. `viewerTakes(text)` says
whether typed input belongs to it (an item is open and the text is not a slash
command); another extension's `input` handler lets such input through, so the
routing does not depend on load order.

`foreground(owner, background)` registers a foreground command of session
`owner` that Ctrl+B can move to the background, and returns the function to
call once it ends or is backgrounded. The owner's detach (its session
shutting down) drops its commands. The fleet extension binds Ctrl+B and calls
`backgroundAll()`, which runs each `background` once and drops one that throws;
`foregrounds()` counts them, and the hint shows while it is above 0.
