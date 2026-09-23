# status

A two-line footer, and quota headroom from QuotaBar.app's loopback feed
(`http://127.0.0.1:<quotaPort>/quotas`). One client with a cache serves the
footer, the tool and the command; concurrent requests share one fetch. If
QuotaBar.app is not running, all three say so plainly. No quota text is added
to agent runs.

## Footer

TUI sessions only; it replaces Pi's footer.

```
model thinking  │  in 12k out 3.4k cache 81% $0.412  │  ctx [███░░░░░░░] 31%
~/repo main*  │  Q claude 78%/41% · codex 12%  │  TTFT 820ms · TPS 64.2
```

- Usage totals cover the current branch (replies, tool results, compactions)
  and update per message, not per draw.
- Context turns amber at 70% and red at 90%; a provider's quota turns amber
  below 50% left and red below 20% in its lowest bucket.
- `*` marks uncommitted changes. `git status` runs in the background at
  session start and 300 ms after the last tool call, one git at a time per
  process, only in trusted projects, and is stopped on shutdown. A git still
  running after 5 s gets SIGTERM, then SIGKILL 2 s later. It never runs
  the repo's own code: fsmonitor, hooks and repo-configured clean filters are
  disabled, and submodules are compared by commit only.
- Quotas show what the shared client holds: after a failed refresh the last
  feed stays until it is older than `quotaRefreshSeconds`, then the footer
  shows `Q unavailable`. A fetch that times out counts as failed.
- TTFT and TPS are for the last reply.

## Tool

- `get_quotas({ provider? })`: one compact line per provider with percent
  left per bucket; reset times only for buckets that are not healthy.

## Command

- `/quota`: the full feed (every bucket, reset time and status) as a
  notification.

## Polling

In TUI sessions the client refreshes the feed on `session_start` and every
`quotaRefreshSeconds`, and stops on shutdown, `/reload` and session switch.
Tool and command calls use a cached feed younger than the interval, else
fetch (8 s timeout; polling uses 5 s).

## `rig.json` settings (`status` section)

| Key | Default | Meaning |
|---|---|---|
| `quotaPort` | `8787` | QuotaBar.app feed port (1 to 65535) |
| `quotaRefreshSeconds` | `60` | Polling interval (5 to 3600) |

Changes made with `/rig` apply immediately: a new port drops the cached feed,
and a new interval restarts polling.
