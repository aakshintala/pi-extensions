# subagents

Background subagents: each one is a copy of the current agent, running as its
own saved Pi session in the same process. Its result comes back as a notice.
It replaces `@tintinweb/pi-subagents`. Spec: #26. This is the core (#52):
nesting (#53), worktrees and fork (#54) and the transcript viewer (#68) come
later.

## Tools

- `subagent_spawn({ description, prompt, model, thinking })` returns the
  agent's id at once. `model` is `provider/id`: an enum of `enabledModels` when
  that is set, otherwise any model Pi knows. `thinking` is a Pi thinking level.
  Neither has a default or a fallback. Spawns beyond `maxConcurrent` queue and
  start when a slot frees.
- `subagent_message({ id, message })`:
  - a running child reads it after its current step
  - a finished child resumes from its saved session and sends a new notice
  - a queued child gets it appended to its prompt
- `subagent_stop({ id })` stops a child. Its notice carries its partial output,
  marked incomplete.

Only the session that spawned an agent can message or stop it. Children get
none of the three tools until nesting (#53).

## Children

- A child starts with the parent's cwd and the extensions, skills and context
  files Pi discovers there, with a fresh conversation. Extensions loaded only
  with `pi -e` are not loaded into children.
- Its session is saved in a folder named after the parent session id, beside
  the parent's session file. The first entry is the custom entry
  `rig.subagent` with `{ agentId, parentSessionId }`. Other extensions use it
  to detect a child session.
- The prompt ends with an instruction to finish on a `STATUS:` line: `DONE`,
  `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`.
- Stopping a child also stops the background work it owns and runs its
  session shutdown. That ends its session-end wait: Pi does not end that wait
  on a bare abort.
- The parent's shutdown stops every child and waits for each to close.

## Notices

The model reads one notice per run:

```
Subagent 3fa9c1d2 (review auth) completed. STATUS: DONE
4 turns · 7 tool uses · 18,204 tokens · $0.0312 · 1m05s

<the child's full final message>
```

- A result longer than `maxInlineChars` is written in full to
  `<child session id>.result.md` beside the child's session file. The notice
  gives the path and the first 1,000 characters.
- A failed child's notice shows the error. A stopped child's notice shows its
  partial output under `Partial output, incomplete:`.
- In FleetView each agent is an `agent` row with its latest tool call or
  message line. When it finishes, the row and the chat line show its `STATUS`.

## `rig.json` settings

Section `subagents`, edited in `/rig`:

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | 10 | Top-level subagents running at once |
| `maxInlineChars` | 16000 | Longest result sent inline; longer ones go to a file |

No commands or keys.
