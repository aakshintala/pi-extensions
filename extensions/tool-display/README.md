# tool-display

Collapses each run of tool calls into one summary line, and draws the built-in
`read`, `edit` and `write` calls in the rig's shared tool style
(`shared/tool-display/`), the way Claude Code shows them.

```
 ⏺ Read 1 file, edited 1 file +3 −2, wrote 1 file +6 · 1 failed

 ⏺ Edit(a.txt)
   ⎿  Error: Could not find the exact text in a.txt. …
```

- **Groups.** Consecutive calls in one assistant message share one summary
  line, counted per verb. It updates live, with a spinner while calls run.
  Text between calls, or a tool without a summary, starts a new group.
- **Failed calls always shown** under their group. After Esc, calls that got
  no result count as `cancelled` in the error colour.
- **Ctrl+O** (`app.tools.expand`) shows every call on its own. In fullscreen
  mode, a click on a group opens or closes that group only.
- **Resumed sessions group the same way**: groups come from the saved
  assistant messages.

Expanded, each call looks like this:

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

Hiding thinking into the group summary is
[#57](https://github.com/aakshintala/pi-rig/issues/57).
