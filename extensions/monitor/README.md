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
- **Flood.** A flood opens at a drop and lasts while drops keep coming, each
  within 2 s of the last, even as refills let a notice through. A flood lasting
  30 s stops the monitor as failed with code `flooded`. 2 s without a drop ends
  it.
- **Deadline.** At its deadline the monitor stops as failed with code `timeout`.
- **Output.** A monitor whose log passes 5 GB stops as failed with code
  `output`.
- **Cap.** Monitors count toward jobs' `maxJobs` (default 16), shared with
  background jobs. A start past it is refused.

## Lifecycle

- A monitor ends when its command exits (one notice with the exit code), at
  its deadline, on a flood, or when stopped. Ending sends SIGTERM to its
  process group. If any of the group is still alive 800 ms later, it gets
  SIGKILL until the group is empty.
- Each monitor is a `monitor` row in FleetView. Opening it shows the live
  standard output log, and x on its row stops it with one notice. `jobs stop <id>`
  stops it too.
- A monitor belongs to its session: shutdown, `/reload` and a session switch
  stop it without a notice. If Pi exits without shutting down, an `exit`
  handler sends SIGKILL to every monitor group. If Pi is killed outright, the
  next Pi reaps the group from its crash record (`<id>.pid`), as jobs do.
- Logs are left in a per-session temporary directory for the OS to clean.

No commands, keys or settings.

