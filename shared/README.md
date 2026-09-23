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
- Loading never throws: a bad value, unknown key or invalid JSON queues one
  warning and uses the default. `notifyWarnings(ui)` sends each once.
- `set`/`reset` validate, re-read the file, change only that key, keep only
  non-default keys, and write atomically (temp file, then rename).
- Redeclaring a section (on `/reload`) re-reads the file, drops the
  section's old listeners and retires the old handle: its `set`/`reset`
  throw. There is no file watcher and no project file.
- `sections()` lists declared sections for the `/rig` menu, and
  `problem(setting, value)` returns why a value is invalid (or nothing).
- `/rig` itself is registered by `extensions/rig`, which also sends the
  load warnings at session start; other extensions need not call
  `notifyWarnings`.

### `tool-display/`

The rig's tool style (spec #40), Claude Code-like. Rig tools and the built-in
`read`/`edit`/`write` render through it.

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

### `text/`

`oneLine(s)` turns model or producer text into one plain line for the screen:
7- and 8-bit CSI, OSC, DCS, SOS, PM and APC sequences are removed, and control
characters and newlines collapse to a space. Used by `extensions/todo`.
