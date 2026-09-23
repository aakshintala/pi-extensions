# subagents

Background subagents: each one is a copy of the current agent, running as its
own saved Pi session in the same process. Its result comes back as a notice.
It replaces `@tintinweb/pi-subagents`. Spec: #26. Built so far: the core
(#52), nesting (#53) and the transcript viewer (#68). Worktrees and fork (#54)
come later.

## Tools

- `subagent_spawn({ description, prompt, model, thinking })` returns the
  agent's id at once. `model` is `provider/id`: an enum of `enabledModels` when
  that is set, otherwise any model Pi knows. `thinking` is a Pi thinking level
  the model supports: Pi would clamp any other level silently, so it is
  refused. Neither has a default or a fallback. Top-level spawns beyond
  `maxConcurrent` queue and start when a slot frees.
- `subagent_message({ id, message })`:
  - a running child reads it after its current step
  - a finished child resumes from its saved session and sends a new notice,
    also after Pi restarts, when the parent session is resumed
  - a queued child gets it appended to its prompt

  Every message, like the spawn prompt, is sent as plain text: a leading
  `/name` is never run as a command or expanded as a template.
- `subagent_stop({ id })` stops a child or any agent below it, and every
  agent under that one. Its notice carries its partial output, marked
  incomplete.

Only the session that spawned an agent can message it; any other session gets
`No subagent <id> of yours`. A stop of an agent outside the caller's subtree
gets `No subagent <id> below you`. From FleetView the user can steer or stop
any agent.

## Nesting

- The main session is depth 0 and its children depth 1. A child below
  `maxDepth` has the same three tools, for its own subtree. A child at
  `maxDepth` has none of them.
- Nested children never queue and take no `maxConcurrent` slot, so a parent
  waiting on its child cannot deadlock the queue.
- `maxSessions` caps the sessions running in one tree: the main session and
  every running agent below it. A nested spawn, or a nested resume, that would
  pass the cap is refused with an error. A top-level spawn waits in the queue
  until the tree has room.
- A stopped agent leaves the cap as soon as the stop is asked for, even while
  it winds down. While an agent is being stopped, nothing new can start below
  it: a spawn or resume there is refused.
- A child that ends its run with its own children or jobs still running gets
  one message listing them, then waits for each notice before it finishes
  (the fleet extension's session-end rule). Its own notice comes after theirs.
- Tokens and cost roll up through the saved sessions. Each finished agent
  saves its counts in its parent's session as a `rig.subagent.usage` entry.
  Each notice saves a `rig.subagent.reported` entry in the agent's own
  session. An agent's notice counts its own replies plus the usage entries
  since its last notice, so a child resumed from FleetView after its parent
  finished still counts in the parent's next notice. `Session total:` counts
  the agent's session and every usage entry, also after a restart.
- A finished agent is dropped from memory once nothing below it is running. A
  later message to it resumes it from its session file.
- In FleetView a nested agent is shown indented under its parent.
- The child's depth is saved in its `rig.subagent` entry, so a child resumed
  after a restart keeps its depth. A child session opened outside its tree,
  for example with `pi --session`, gets none of the tools.

## Children

- A child starts with a fresh conversation in the parent's cwd. It inherits
  (#26 story 8):
  - the parent's active tools, as its tool allowlist
  - the parent's `enabledModels`, so its own `subagent_spawn` offers the same
    models
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
  entry is the custom entry `rig.subagent` with `{ agentId, parentSessionId, depth }`,
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
  and waits for each to close, 10 seconds at most for the whole tree below
  it. Their notices are saved in the parent's session, because FleetView no
  longer delivers to it. A child still running after 10 seconds, such as one
  whose model stream ignores its abort, is reported stopped with
  `did not stop in time`. Its session is shut down and disposed, so it
  records and spends nothing more. It counts toward `maxSessions` until its
  run settles.
- A child's instance keeps what it last passed on (tools, prompt sections,
  models), so the user can still resume a finished child from FleetView after
  that child's parent session has closed.

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

## Transcript

Opening an agent in FleetView shows its conversation in the viewer, drawn like
the main chat:

- Pi's own user, assistant and tool components. Each call is drawn with its
  tool's definition from the agent's session, so built-ins such as `bash` look
  as they do in Pi. A call to a tool Pi does not know shows its raw arguments.
- Tool calls group into one line as in the main chat, and Ctrl+O or a click
  opens a group. Thinking is hidden when Pi's `hideThinkingBlock` is on, read
  when the transcript is first opened.
- A running agent is followed live: new messages, streaming replies and
  running tool output. The viewer stays open when the agent finishes.
- A finished agent opens from its saved session. If its parent resumes it
  while the viewer is open, the viewer follows the new run.
- Typing steers the agent. The steer shows as `Steering: …` until the agent
  reads it, then as a user message. Ctrl+Q, then y, stops it.
- Compaction summaries are not drawn.

## `rig.json` settings

Section `subagents`, edited in `/rig`:

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | 10 | Top-level subagents running at once |
| `maxInlineChars` | 16000 | Longest result sent inline; longer ones go to a file |
| `maxDepth` | 2 | Deepest subagent level; agents there get no subagent tools |
| `maxSessions` | 32 | Sessions running in one tree of agents, root included |

No commands or keys.
