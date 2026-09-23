# tool-display

Draws the built-in `read`, `edit` and `write` calls in the rig's shared
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
- **Pi's own tools.** `read`, `edit` and `write` are built from Pi's
  exported tool definitions, so their descriptions, parameters and execution
  are Pi's. Registering them under the same names replaces the built-ins; only
  the rendering changes. `read` always resizes images (the built-in default):
  extensions cannot read Pi's image setting.
- **Not `ls`.** Pi activates every tool an extension registers, and `ls` is
  off by default, so registering it would add prompt tokens. When you enable
  `ls`, it keeps Pi's own look.

No commands, keys or settings.

Grouping runs of calls into one summary line is
[#56](https://github.com/aakshintala/pi-rig/issues/56); hidden thinking and
click-to-expand are [#57](https://github.com/aakshintala/pi-rig/issues/57).
