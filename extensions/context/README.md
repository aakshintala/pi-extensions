# context

`/context`: what fills the model context, and what extensions inject into it.
Spec: [#36](https://github.com/aakshintala/pi-rig/issues/36).

- `/context` (or `/context usage`): a map of the context window by category
  (system prompt, tools, messages, tool output, extensions and more), with the
  auto-compact buffer and free space. Enter previews a category.
- `/context injections`: the system prompt, tool definitions and extension
  injections captured at the first turn, with token estimates. Enter previews
  an item.
- The first turn is captured passively. Opened before any turn, `/context`
  runs one silent probe turn: it is aborted before the model is called, and
  leaves no rows in the transcript and nothing in later model requests.
- `/context` never aborts or delays a running turn: it waits for the turn to
  end and reuses its capture.
- System messages that extensions add to requests (Pi 0.87's
  `context_with_system`) are counted as injections.
- Colours come from the theme. The mouse wheel scrolls in fullscreen mode.
- Without the TUI, `/context` says so.

## Keys

| Key | Does |
|---|---|
| ↑ ↓ / j k, PgUp PgDn, Home End | Move or scroll |
| Enter | Opens the selected row |
| Esc / q | Back, or closes |

## Tools and settings

None.

## Upstream

Ported from [`pi-context-view`](https://github.com/dimk90/pi-context-view)
0.6.0, MIT licence (see `LICENSE`). Cut: `pi-context-view.json` and
`/context config`, hex colours, prompt parsing for Pi 0.80–0.85, guessed
attribution of prompt additions (they show as unattributed), skill badges and
zoom.
