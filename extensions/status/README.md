# status

Quota headroom from QuotaBar.app's
loopback feed (`http://127.0.0.1:<quotaPort>/quotas`). One client with a
cache serves the tool and the command; concurrent requests share one fetch.
If QuotaBar.app is not running, both say so plainly. The two-line footer is
[#66](https://github.com/aakshintala/pi-rig/issues/66).

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
| `quotaRefreshSeconds` | `60` | Polling interval (5 to 3600); applies from the next session start |
