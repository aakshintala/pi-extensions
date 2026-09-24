# tool-display

Collapses each run of tool calls into one summary line, and draws the built-in
`read`, `edit` and `write` calls in the rig's shared tool style
(`shared/tool-display/`), the way Claude Code shows them.

```
 ⏺ Read 1 file, edited 2 files +3 −2, wrote 1 file +6
```

- **Groups span responses (#133).** Consecutive calls share one summary line,
  across assistant responses, so an agent run of tool-only responses is one
  line. Shell executions fold into the groups around them. Every call counts
  under its verb; `+a −r` comes from finished edits and writes. It updates live,
  while Pi's editor shows the only animated working indicator. Inside a group, the calls after the first and
  the tool-only responses between them draw no rows.
- **What splits a group:** assistant text, thinking that is shown (Ctrl+T, or a
  click on the block), your prompt, a steer or follow-up, an agent completion
  notice, a tool without a summary (such as `ask_user`), and
  the end of the agent run. Hidden thinking does not. A finished shell job or
  monitor draws no notice, so it never splits a group.
- **Failed, cancelled and image calls stay folded** under their group's summary,
  with no blank rows or alerts. Ctrl+O or a click reveals failure details.
  Image calls draw no text rows collapsed (Pi still draws the image itself).
- **Slow calls show; fast ones never flash.** A pending group draws nothing until
  a call settles or runs for a second, so a quick read never appears and
  disappears. Genuinely slow calls get a static summary row.
- **Running calls with a hint show** outside the summary, with a static mark and a
  dim hint line, and fold back in when they end. A foreground `bash` shows its
  elapsed time this way (#162), with `ctrl+b to run in background` added while
  Ctrl+B is free (#139):

  ```
   ⏺ Ran 1 shell command
   ⏺ Bash(npm test)
     ⎿  12s · ctrl+b to run in background
  ```

- **Cancelled.** When a turn is aborted (Esc), calls with no result and calls
  whose error ends in Pi's `Operation aborted` or `Command aborted` count as
  `cancelled` when expanded. Any other returned error stays failed and folded.
- **Ctrl+O** (`app.tools.expand`) shows every call on its own. In fullscreen
  mode, a click on a group opens or closes that group only (Pi sends mouse
  clicks only in fullscreen mode).
- **Resumed sessions group the same way**: groups come from the saved
  messages, and cancels and failures are told apart from saved data. So do
  subagent transcripts.
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
- **Expanded errors.** An expanded failed call shows `Error:` and the message,
  wrapped to the terminal width.
- **Pi's own tools.** `read`, `edit` and `write` are built from Pi's
  exported tool definitions, so their descriptions, parameters and execution
  are Pi's. Registering them under the same names replaces the built-ins; only
  the rendering changes. `read` always resizes images (the built-in default):
  extensions cannot read Pi's image setting.
- **Not `ls`.** Pi activates every tool an extension registers, and `ls` is
  off by default, so registering it would add prompt tokens. When you enable
  `ls`, it keeps Pi's own look.

## Thinking

- **Hidden thinking renders nothing.** With thinking hidden (Ctrl+T), Pi's
  "Thinking..." label and its blank line are gone, in messages with and
  without text. A group starts with `thought ·` when any of its responses
  had thinking, or a response with only thinking came inside it:

  ```
   ⏺ thought · read 5 files, ran 7 shell commands
  ```

- **Shown thinking** starts with a `✻ Thinking` label line, and splits a tool
  group like text does. Ctrl+T regroups the calls on screen.
- **Screen only.** Saved sessions and the model's context are unchanged.
- **Guarded Pi patch** (one of the rig's three, #1). It wraps
  `AssistantMessageComponent.prototype.updateContent` on Pi 0.87.x only, and
  only when the message's children are exactly what Pi 0.87 builds; anything
  else, or an error while restyling, keeps Pi's own render. A thinking block
  you clicked open or closed keeps Pi's render; the message's other blocks are
  still restyled. The same wrapper tells the tool groups whether the message's
  thinking is shown. It is no new patch.
- **One patch per process.** It is installed once while any session, including
  in-process subagent sessions, uses the extension, and removed with the last
  one. `/new`, `/resume` and a `/reload` without the extension get Pi's stock
  render; a `/reload` with a subagent session up runs the reloaded code. If
  something else wraps the same method later, the patch goes inert instead.

## Your prompts

Pi already marks your own prompts with two theme keys, so the rig adds no code
and no patch for them:

- `userMessageBg`: the background behind each prompt.
- `userMessageText`: the prompt's text colour.

Recommended values, the ones Pi's built-in themes use:

| Theme | `userMessageBg` | `userMessageText` |
| ----- | --------------- | ----------------- |
| dark  | `#343541`       | `text`            |
| light | `#e8e8e8`       | `text`            |

Set them in your theme file. A theme switch picks up the new theme's values.
The fleet viewer's transcript (`extensions/fleet/viewer.ts:332`) draws prompts
with the same Pi component, so they look the same there.

Where Pi 0.87.1 reads them (in `dist/modes/interactive/`):

- `components/user-message.js:29` (`userMessageBg`) and `:31` (`userMessageText`)
- `theme/dark.json:16,40-41` and `theme/light.json:15,39-40`

No commands, keys or settings.
