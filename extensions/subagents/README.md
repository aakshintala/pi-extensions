# subagents

Background subagents: each one is a copy of the current agent, running as its
own saved Pi session in the same process. Its result comes back as a notice.
It replaces `@tintinweb/pi-subagents`. Spec: #26. This is the core (#52):
nesting (#53), worktrees and fork (#54) and the transcript viewer (#68) come
later.

## Tools

- `subagent_spawn({ description, prompt, model, thinking })` returns the
  agent's id at once. `model` is `provider/id`: an enum of `enabledModels` when
  that is set, otherwise any model Pi knows. `thinking` is a Pi thinking level
  the model supports: Pi would clamp any other level silently, so it is
  refused. Neither has a default or a fallback. Spawns beyond `maxConcurrent` queue and
  start when a slot frees.
- `subagent_message({ id, message })`:
  - a running child reads it after its current step
  - a finished child resumes from its saved session and sends a new notice,
    also after Pi restarts, when the parent session is resumed
  - a queued child gets it appended to its prompt

  Every message, like the spawn prompt, is sent as plain text: a leading
  `/name` is never run as a command or expanded as a template.
- `subagent_stop({ id })` stops a child. Its notice carries its partial output,
  marked incomplete.

Only the session that spawned an agent can message or stop it; any other
session gets `No subagent <id> of yours`. Children get none of the three tools
until nesting (#53).

## Children

- A child starts with a fresh conversation in the parent's cwd. It inherits
  (#26 story 8):
  - the parent's active tools, as its tool allowlist
  - the parent's system prompt sections as of the parent's latest run: the
    custom prompt, appended prompt, context files (AGENTS.md) and skills
  - the extensions Pi discovers for that cwd and agent dir
- Before the parent's first run, there are no sections to copy, so a child
  discovers its own. This happens only with a resume after a restart.
- Extensions loaded only with `pi -e` are not loaded into children. Pi
  0.87.1's extension API has no way to list loaded extension paths: only
  tools and commands carry a `sourceInfo` path.
- Its session is saved in a folder named after the parent session id, beside
  the parent's session file. The child's session id is its agent id. The first
  entry is the custom entry `rig.subagent` with `{ agentId, parentSessionId }`,
  and the session name is the description. Other extensions use the entry to
  detect a child session.
- Pi writes a session file only after its first assistant message. A child
  stopped while queued, or before its first reply, leaves no file, so it
  cannot be resumed.
- The prompt ends with an instruction to finish on a `STATUS:` line: `DONE`,
  `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`.
- Stopping a child aborts it and stops the background work it owns. It then
  waits up to 5 seconds for that work to stop, and runs the child's session
  shutdown. The shutdown ends the child's session-end wait: Pi does not end
  that wait on a bare abort.
- The parent's shutdown (quit, `/new`, a session switch) stops every child
  and waits for each to close. Their notices are saved in the parent's
  session, because FleetView no longer delivers to it.

## Notices

The model reads one notice per run:

```
Subagent 3fa9c1d2 (review auth) completed. STATUS: DONE
4 turns · 7 tool uses · 18,204 tokens · $0.03 · 1m05s

<the child's full final message>
```

- A resumed child's notice adds `Session total:`, which covers every run of
  that session. The per-run line covers this run only.
- Costs below a cent keep two significant digits, for example `$0.000030`.
- A result longer than `maxInlineChars` is written in full to
  `<agent id>.result.md` beside the child's session file. The file is written
  to a temporary file first, then renamed. The notice gives the path and the
  first 1,000 characters.
- If the file cannot be written, the notice carries the result inline, cut to
  `maxInlineChars` characters and marked as truncated.
- A failed child's notice shows the error. A stopped child's notice shows its
  partial output under `Partial output, incomplete:`.
- In FleetView each agent is one `agent` row with its latest tool call or
  message line. When it finishes, the row and the chat line show its `STATUS`.
- A resume turns the finished row back into a running one, with its own
  running time, so each agent keeps one row.

## `rig.json` settings

Section `subagents`, edited in `/rig`:

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | 10 | Top-level subagents running at once |
| `maxInlineChars` | 16000 | Longest result sent inline; longer ones go to a file |

No commands or keys.
