# tool-display

Draws the built-in `read`, `edit`, `write` and `ls` calls in the rig's shared
tool style (`shared/tool-display/`), the way Claude Code shows them:

```
 ⏺ Edit(b.txt)
   ⎿  Added 3 lines, removed 2 lines
      -two
      -three
      +2
      +3
      … +1 line (ctrl+o to expand)
```

- **Collapsed results.** Each result shows a one-line summary and at most four
  lines; Ctrl+O (`app.tools.expand`) shows up to 200.
- **Edit diffs from the arguments.** The diff is computed from the call's
  `oldText`/`newText`, never by reading the file. Edits over 100,000
  characters show no diff.
- **Errors always shown.** A failed call shows `Error:` and the message, wrapped
  to the terminal width.
- **Built-ins only.** A tool another extension registers under one of these
  names keeps its own look.

Pi does not expose built-in tool definitions to extensions, so the decoration
sits on `ToolExecutionComponent`'s renderer lookups. It is installed once at
`session_start` and removed at `session_shutdown`, including on `/new`,
`/resume`, fork and `/reload`.

No tools, commands, keys, settings or prompt text.

Grouping runs of calls into one summary line is
[#56](https://github.com/aakshintala/pi-rig/issues/56); hidden thinking and
click-to-expand are [#57](https://github.com/aakshintala/pi-rig/issues/57).
