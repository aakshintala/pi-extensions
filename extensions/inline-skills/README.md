# inline-skills

Write `/skill-name` anywhere in a prompt to load that skill for the turn, for
example `let's /tdd this, then /grilling`. Ported from
[`@tifan/pi-inline-skills`](https://www.npmjs.com/package/@tifan/pi-inline-skills)
1.0.6 (MIT) for spec [#36](https://github.com/aakshintala/pi-rig/issues/36).

It registers no tools, no commands and no settings.

## Loading

- The prompt is sent unchanged. Each newly named skill's body follows it in one
  `inline-skill` message, shown as `[skill] <name>` rows (`Ctrl+O` expands them).
- Steering and follow-up messages, typed or queued, carry their skills in the
  same message, in the block form Pi uses for `/skill:name`. The live transcript
  shows only your text; the `[skill]` row appears when the session is reopened.
- A skill counts as loaded once its message reaches the model, so a prompt Pi
  refuses loads nothing. It loads once per session branch; moving to another
  point in the tree (`/tree`) restores the set loaded on that branch.
- At the start of a prompt, a registered command or prompt template with the
  same name wins.
- Prompts naming no skill cost nothing. Skill files are read asynchronously when
  the message is delivered; an unreadable one is reported and skipped.

## Autocomplete

- Typing `/` and two letters mid-prompt opens the skill list; `Tab` opens it at
  any point. Names starting with what you typed come first, then names
  containing it. `Tab` or `Enter` inserts `/name `.
- A `/` at the start of the message still opens Pi's command list, and a token
  with a second `/`, such as `/usr/lo`, still completes as a path.

The list opens on typing through a guarded patch of Pi's main editor instance
(one of the rig's three, see [#1](https://github.com/aakshintala/pi-rig/issues/1)).
It is applied at each session start and skipped when the Pi version is not
0.87 or the editor's shape differs, leaving `Tab`-only completion.
