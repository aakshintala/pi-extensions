# stamp

Shows one dim transcript line when an agent run settles, for example `✻ Worked for 49s · done 4:55 PM`. It records the run start and settlement time, not individual messages or tool calls. Runs that do not reach `agent_settled` produce no entry.

The extension registers no tools or commands. Its `stamp` section in `rig.json` supports:

| Key | Default | Meaning |
|---|---|---|
| `hourCycle` | `12h` | `12h` or `24h` clock display |
| `locale` | `invariant` | `invariant`, `system`, or a BCP 47 locale |
| `timeZone` | `local` | `local` or an IANA time zone |

Previously saved per-message pi-stamp entries remain in session logs and are ignored by this renderer.
