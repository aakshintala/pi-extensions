# usage

`/usage`: cost and token usage across all your sessions, as a braille graph
or a provider table, for today, this week, last week, the last 30 days or all
time. Spec: [#36](https://github.com/aakshintala/pi-rig/issues/36).

- Sessions are read from Pi's session folder: `PI_CODING_AGENT_SESSION_DIR`,
  else the `sessionDir` setting, else `<agentDir>/sessions`.
- The graph and the table bucket usage by the same local hours and days, in
  any time zone.
- Every recorded cost counts, whatever shape it was stored in, including
  usage reported by tools, compactions and branch summaries (shown as
  `Tools / summaries`).
- Parsed sessions are cached in `<agentDir>/usage-extension-cache.json`
  (upstream's format), so later runs only read changed files.
- Long tables scroll with the selection. Graph colours come from the theme.
- Without the TUI, or when reading sessions fails, `/usage` says so.

## Keys

| Key | View | Does |
|---|---|---|
| Tab / → , Shift+Tab / ← | Both | Next or previous period |
| v | Both | Switches graph and table |
| q / Esc | Both | Closes |
| m, g, c | Graph | Cycles metric, grouping, cumulative |
| ↑ ↓, Enter | Graph | Selects a legend row, hides or shows its series |
| a | Graph | Shows every series |
| ↑ ↓, Enter | Table | Selects a provider, expands its models |

## Tools and settings

None.

## Upstream

Ported from [`@tmustier/pi-usage-extension`](https://github.com/tmustier/pi-extensions/tree/main/usage-extension)
0.9.5, MIT licence (see `LICENSE`). Cut: export, the table filter and hide
keys, the formula footer and the Insights view.
