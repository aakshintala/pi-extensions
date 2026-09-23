# tool-display

Collapses each run of tool calls into one summary line, and draws the built-in
`read`, `edit` and `write` calls in the rig's shared tool style
(`shared/tool-display/`), the way Claude Code shows them.

```
 ⏺ Read 1 file, edited 2 files +3 −2, wrote 1 file +6 · 1 failed

 ⏺ Edit(a.txt)
   ⎿  Error: Could not find the exact text in a.txt. …
```

- **Groups.** Consecutive calls in one assistant message share one summary
  line. Every call counts under its verb; `+a −r` comes from finished edits and
  writes. It updates live, with a spinner while calls run. Text between calls,
  or a tool without a summary, starts a new group.
- **Failed calls always shown** under their group, and so are calls that
  returned an image (Pi draws images outside the tool's renderers).
- **Cancelled.** Calls with no result when the turn is aborted (Esc), or with
  Pi's `Operation aborted` result, count as `cancelled` in the error colour.
  They are counted, not shown.
- **Ctrl+O** (`app.tools.expand`) shows every call on its own. In fullscreen
  mode, a click on a group opens or closes that group only (Pi sends mouse
  clicks only in fullscreen mode).
- **Resumed sessions group the same way**: groups come from the saved
  assistant messages, and cancels and failures are told apart from saved data.
- **Per session.** Each session has its own groups, so an in-process subagent
  session never touches its parent's.
- **Text order (limit).** Pi draws all of an assistant message's text before its
  tool calls, so text written between two runs shows above both groups, not
  between them. Fixing that would need a Pi patch.

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
