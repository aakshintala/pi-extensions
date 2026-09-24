# subagents

Background subagents: each one is a copy of the current agent, running as its
own saved Pi session in the same process. Its result comes back as a notice.
It replaces `@tintinweb/pi-subagents`. Spec: #26. Built: the core (#52),
nesting (#53), the transcript viewer (#68), and worktrees and fork (#54).

## Tools

- `subagent_spawn({ description, prompt, model, thinking, isolation, fork? })`
  returns the agent's id at once. `model` is `provider/id`: an enum of `enabledModels` when
  that is set, otherwise any model Pi knows. `thinking` is a Pi thinking level
  the model supports: Pi would clamp any other level silently, so it is
  refused. Neither has a default or a fallback. `isolation` is `none` or
  `worktree` (see Worktrees). `fork: true` starts the child from a copy of the
  conversation (see Children). Top-level spawns beyond `maxConcurrent` queue
  and start when a slot frees.
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

- A child starts with a fresh conversation in the parent's cwd, or in its
  worktree. With `fork: true` it starts from a copy of the parent's
  conversation as the parent's model sees it at the spawn: after a compaction,
  the summary and the kept messages. The spawn call that started it has no
  result in the copy. It inherits (#26 story 8):
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
  plus `worktree` for a worktree child,
  and the session name is the description. Other extensions use the entry to
  detect a child session.
- Pi writes a session file only after its first assistant message. A child
  stopped while queued, or before its first reply, leaves no file, so it
  cannot be resumed. A fork whose copy holds a reply is saved at the spawn.
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

## Worktrees

With `isolation: "worktree"` the child works in its own git worktree:

- It is made at the spawn from the `HEAD` of the repository holding the
  parent's cwd, on the new branch `subagent/<id>`, at
  `<agent dir>/rig-worktrees/<id>`. The child's cwd is the parent's cwd mapped
  into it. Nothing is committed for the child.
- Git runs through `shared/git`: the repository's hooks, fsmonitor and its own
  clean, smudge and process filters never run. Each git is stopped after 2
  minutes, and a spawn's git stops when its tool call is aborted; the spawn
  is then refused.
- Outside a git repository, or in one with no commit, the spawn is refused
  with an error, and nothing is created.
- The spawn result and each notice give the path and branch. When the child
  finishes, its notice also says what happened to the worktree:
  - removed, with nothing uncommitted, no untracked or ignored file (such as
    `.env`) and no commit missing from every remote. The branch is deleted
    too, with `git branch -d`, when it never moved; a moved branch is kept.
  - kept, with uncommitted changes, untracked or ignored files, or unpushed
    commits, or when git fails. A worktree is never removed with `--force`.
- A resume runs in the same worktree, recreated at the same path on its branch
  if it was removed (after `git worktree prune`, in case its directory was
  deleted behind git's back). If anything else is at the path, such as a plain
  directory, a file or a symlink, the run fails and leaves it alone.
- The worktree is saved in the child's `rig.subagent` entry, so a resume after
  a restart finds it. That entry is checked before the session file is opened:
  the path must be `<agent dir>/rig-worktrees/<id>`, the branch
  `subagent/<id>`, the repository the one holding the parent's cwd, and the
  child's cwd inside the worktree. Anything else refuses the resume.
- A worktree child's own children work in its worktree by default.
- A worktree child stopped while queued has its worktree settled the same way.
  One given up on at the parent's shutdown keeps its worktree.

## Notices

The model reads one notice per run:

```
Subagent 3fa9c1d2 (review auth) completed. STATUS: DONE
4 turns · 7 tool uses · 18,204 tokens · $0.03 · 1m05s

<the child's full final message>
```

- A worktree child's notice adds its `Worktree:` line after the counts.
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
- After its status the row shows the model and thinking level, then its tokens
  and cost once they are above zero. They count its session over every run
  plus each child once it finishes, as `Session total:` does. A finished row
  adds the latest run's turns and tool uses. A worktree agent's row ends with
  its branch, or `worktree removed`. For example:
  `agent scout · done 2m13s · kid-1 · low · 41.2k tokens · $0.31 · 12 turns · 34 tool uses`.
- A resume turns the finished row back into a running one, with its own
  running time, so each agent keeps one row.

## Events

Each run emits on the spawning session's `pi.events`, in
`@tintinweb/pi-subagents`' vocabulary, so a card-status consumer such as
pane-pi needs no fleet internals: `subagents:started` when the run starts,
then `subagents:failed` if it failed, else `subagents:completed` (stopped
included). The payload is `{ id }`. A child's run ends only after its own
children's, and an agent stopped while queued emits nothing.

## Transcript

Opening an agent in FleetView shows its conversation in the viewer, drawn like
the main chat:

- Pi's own user, assistant and tool components. Each call is drawn with its
  tool's definition from the agent's session. Without a live session, it uses
  the definitions of the child sessions its tree of agents has run, the rig's
  renderers included, then Pi's built-ins. They are held by the tree's root
  session and go with it. So after a restart or `/reload`, until a child
  session runs, a finished agent's calls draw with Pi's stock renderers,
  ungrouped. A call to a tool none of them knows shows its raw arguments.
- Tool calls group into one line as in the main chat, and Ctrl+O or a click
  opens a group. Thinking is hidden when Pi's `hideThinkingBlock` is on, read
  on each open.
- Opening draws the last 200 messages, with a `… N earlier messages` line for
  the rest. After that, only new entries are added.
- Messages from extensions, such as notices, show as plain muted text with
  control sequences removed.
- The transcript reads the agent's session in memory and never opens or
  writes its file. Closing the viewer releases it.
- A running agent is followed live: new messages, streaming replies and
  running tool output. The viewer stays open when the agent finishes.
- A finished agent opens from its saved session. If its parent resumes it
  while the viewer is open, the viewer follows the new run.
- Typing steers the agent. The steer shows as `Steering: …` until the agent
  reads it, then as a user message. x on its FleetView row stops it, and
  Ctrl+X, then Ctrl+K, in FleetView stops every agent the session started.
- A compaction keeps the messages already drawn, as the main chat keeps its
  scrollback. The compaction summary is not drawn.

## `rig.json` settings

Section `subagents`, edited in `/rig`:

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | 10 | Top-level subagents running at once |
| `maxInlineChars` | 16000 | Longest result sent inline; longer ones go to a file |
| `maxDepth` | 2 | Deepest subagent level; agents there get no subagent tools |
| `maxSessions` | 32 | Sessions running in one tree of agents, root included |

No commands or keys.
