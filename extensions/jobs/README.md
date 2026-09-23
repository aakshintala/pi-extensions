# jobs

Background shell work: `bash` moves long commands into the background as jobs,
and `jobs` lists, waits on and stops them. It replaces `pi-patty-bg-tasks`.
Spec: #30. This is #48: the guards and crash clean-up (#49), `monitor` (#50)
and Ctrl+B (#51) come later.

## Tools

- `bash({ command, timeout?, run_in_background? })` replaces Pi's built-in.
  It runs Pi's own bash tool over this extension's process backend, so a
  command that finishes in the foreground returns exactly what Pi's returns.
  - `run_in_background: true` returns the job ID and log path at once.
  - A command still running after `autoBackgroundSeconds` becomes a job, and
    the call returns its job ID and log path.
  - `timeout` is a hard limit in seconds that kills the command, also after it
    became a job. The job then fails as timed out.
  - Esc kills a foreground command.
- `jobs({ action, id?, timeout? })`:
  - `list`: the session's jobs with status, running time, log path and command.
  - `wait`: returns when the job ends or after `timeout` seconds (default 30,
    clamped to 10-3,600), with its status and last lines. Cancelling the wait
    leaves the job running.
  - `stop`: SIGTERM to the job's process group, then SIGKILL 800 ms later if
    any of it is still alive.

Only the session that started a job can see, wait on or stop it.

## Jobs

- Each command runs as its own process group, with standard output and error
  written straight to a log file in a per-session temporary directory. The
  logs are left for the OS to clean.
- A job ends when its shell exits, so a daemon that keeps the log open cannot
  hold it.
- Each job is a `shell` row in FleetView. Opening it shows the live log, and
  Ctrl+Q stops it.
- Each job ends with exactly one notice: status, exit code, running time and
  log path. A failed job's notice carries its last 20 lines, cut to 2,000
  characters. A `wait` or `stop` that returned the final state replaces the
  notice.
- Shutdown, `/reload` and a session switch stop every job, without a notice.

## Settings

`rig.json` section `jobs`:

| Key | Default | Range | Does |
|---|---|---|---|
| `autoBackgroundSeconds` | 30 | 1-3,600 | Seconds before a running `bash` command moves to the background |

No commands or keys.

## Limits

- `bash` uses Pi's default shell. Pi's `shellPath` and `shellCommandPrefix`
  settings are not applied: extensions cannot read them.
- A command's running time on its FleetView row counts from when it became a
  job; its notice counts from when it started.
