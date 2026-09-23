# monitor

`monitor` runs a watch command in the background and turns what it prints into
notices for the agent, with Claude Code's limits. Spec: #30. Ticket: #50.

## Tool

`monitor({ command, description, timeout? })` starts the command and returns
its ID and log paths at once.

- Each batch of standard output lines that arrive together is one notice,
  headed with the monitor's ID and `description`. Terminal sequences and
  control characters are removed.
- Each line is cut at 500 characters, and each notice at 3,000, counting code
  points. A notice shows at most the first 100 characters of the description,
  so the drop count and the lines always fit.
- Standard error goes to a separate log (`<id>.err.log`) and never becomes a
  notice.
- `timeout` is the deadline in seconds: 300 by default, at most 1,800, or 600
  without the UI. A larger value is clamped.

## Limits

- **Rate.** Notices draw from a budget of 10, refilled one every 2 s. A batch
  that finds it empty is dropped and counted, and the next notice says how many
  were suppressed.
- **Flood.** 30 s of continuous suppression stops the monitor as failed with
  code `flooded`. Suppression starts at the first drop after a notice, and any
  delivered notice ends it.
- **Deadline.** At its deadline the monitor stops as failed with code `timeout`.

## Lifecycle

- A monitor ends when its command exits (one notice with the exit code), at
  its deadline, on a flood, or when stopped. Ending sends SIGTERM to its
  process group. If any of the group is still alive 800 ms later, it gets
  SIGKILL until the group is empty.
- Each monitor is a `monitor` row in FleetView. Opening it shows the live
  standard output log, and Ctrl+Q stops it with one notice.
- A monitor belongs to its session: shutdown, `/reload` and a session switch
  stop it without a notice. If Pi exits without shutting down, an `exit`
  handler sends SIGKILL to every monitor group.
- Logs are left in a per-session temporary directory for the OS to clean.

No commands, keys or settings.

## Not yet

- `jobs stop` does not reach monitors yet; the model cannot stop one before
  it ends.
