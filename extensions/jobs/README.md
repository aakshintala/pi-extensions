# jobs

Background shell work: `bash` moves long commands into the background as jobs,
and `jobs` lists, waits on and stops them. It replaces `pi-patty-bg-tasks`.
Spec: #30. Built in #48, #49 (guards and crash clean-up) and #51
(backgrounding a running command); `monitor` is its own extension.

## Tools

- `bash({ command, timeout?, run_in_background? })` replaces Pi's built-in.
  It runs Pi's own bash tool over this extension's process backend, so a
  command that finishes in the foreground returns exactly what Pi's returns.
  - `run_in_background: true` returns the job ID and log path at once.
  - A command still running after `autoBackgroundSeconds` becomes a job, and
    the call returns its job ID and log path.
  - `timeout` is a hard limit in seconds that kills the command, also after it
    became a job. The job then fails as timed out.
  - Ctrl+B moves every running foreground command to the background. Each
    call returns its job ID and log path.
  - A steering message submitted while a command runs (through the queue)
    moves that session's foreground commands to the background too, so the
    turn ends and the message is delivered as steering, without an abort.
    A follow-up (Option+Enter) waits as usual.
  - Esc kills a foreground command.
  - A bare `sleep` is refused with a pointer to polling loops, `jobs wait`,
    `run_in_background` and `monitor`. `sleep` inside a `while` or `until`
    loop, backgrounded with `&`, or in a function body, runs. The check parses
    the command: quoted text, comments and heredoc bodies are not commands,
    and it sees through `command`, `exec`, `env`, `nice`, `nohup`, `timeout`,
    `/bin/sleep`, `\sleep`, `$(...)` and backticks.
- `jobs({ action, id?, timeout? })`:
  - `list`: the session's jobs with status, running time, log path and command.
  - `wait`: returns when the job ends or after `timeout` seconds (default 30,
    clamped to 10-3,600), with its status and last lines. Cancelling the wait
    leaves the job running.
  - `stop`: SIGTERM to the job's process group, then SIGKILL 800 ms later if
    any of it is still alive. It also ends processes a finished job left
    running, such as `sleep 60 &`. Given a monitor's id, it stops that monitor.

Only the session that started a job can see, wait on or stop it.

## Jobs

- Each command runs as its own process group, with standard output and error
  written straight to a log file in a per-session temporary directory. The
  logs are left for the OS to clean.
- A job ends when its shell exits, so a daemon that keeps the log open cannot
  hold it. If the shell left processes running in its group, the notice, `wait`
  and `list` say so.
- Each job is a `shell` row in FleetView. Opening it shows the live log, and
  Ctrl+Q stops it.
- Each job ends with exactly one notice: status, exit code, running time and
  log path. A failed job's notice carries its last 20 lines, cut to 2,000
  characters. A `wait` or `stop` that returned the final state replaces the
  notice.
- Shutdown, `/reload` and a session switch stop every job of that session,
  and whatever its finished commands left running, without a notice. Other
  sessions in the process keep theirs.
- If Pi exits without shutting down (a crash, a lost terminal), an `exit`
  handler sends SIGKILL to every job group it started.
- When a job starts, its process group, its leader's start time and Pi's
  pid and start time are recorded next to its log, until the group is
  empty. When a session starts, groups recorded by a Pi that has ended
  (killed with SIGKILL, for example) are killed, but only while the leader's
  start time still matches, so a reused pid is never signalled. Only this
  user's 0700 directories and 0600 records are read, and group ids of 1 or
  less are refused. A Pi counts as ended only when its pid is gone or
  belongs to a later process; a failed `ps` counts as running. A group id is
  forgotten as soon as the group is seen empty. This lives in
  `shared/process-groups`, which monitors use too.

## Guards

- At most `maxJobs` jobs and monitors, across every session of the process,
  run at once, counting jobs whose shell exited while their leftover
  processes still run; `run_in_background` past that is refused. A foreground
  command can still run, and can still move to the background after
  `autoBackgroundSeconds`. 16 is above the peak of 10 at once measured in
  the user's Pi session logs.
- A job whose log passes 5 GB is stopped, and its notice says so. So are the
  processes a finished job left running, with a notice of their own.
- A background job whose output has not changed for 10 seconds and that
  stopped on an unfinished prompt line (`[y/N]`, `Password:`, `? Pick one`,
  or a line ending in `? ` or `> `) sends one notice saying it may be waiting
  for input.
- A job being stopped does not report leftover processes while its SIGKILL
  is still pending.
- Tool output is drawn without terminal sequences or control characters, as
  Pi's own `bash` draws it.

## Settings

`rig.json` section `jobs`:

| Key | Default | Range | Does |
|---|---|---|---|
| `autoBackgroundSeconds` | 30 | 1-3,600 | Seconds before a running `bash` command moves to the background |
| `maxJobs` | 16 | 1-64 | Most background jobs and monitors running at once |

No commands. Ctrl+B is bound by the fleet extension.

## Limits

- `bash` uses Pi's default shell. Pi's `shellPath` and `shellCommandPrefix`
  settings are not applied: extensions cannot read them.
- A process that calls `setsid` (or a daemon that does) leaves the job's
  process group, so stop, shutdown and the exit handler cannot reach it.
- After a killed Pi, a job whose shell had already exited keeps what it
  left running: without its leader the group cannot be proven to be the
  job's.
- The log size is checked once a second, so a very fast writer can pass
  5 GB by up to a second's output.
- A `sleep` inside `bash -c "..."` or `eval` is not seen.
- A command's running time on its FleetView row counts from when it became a
  job; its notice counts from when it started.
