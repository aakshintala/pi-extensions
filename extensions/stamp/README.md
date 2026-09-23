# stamp

Right-aligned timestamps under each message in the transcript, with optional
response timing, model metadata, cost and tool durations. Ported from the local
fork of [`@narumitw/pi-stamp`](https://www.npmjs.com/package/@narumitw/pi-stamp)
0.51.0 (MIT) for spec [#36](https://github.com/aakshintala/pi-rig/issues/36).

## What it records

In TUI sessions, every user message and every response gets a `pi-stamp` session
entry. A response's entry records its timing, model metadata, thinking level,
cost since your last message and the duration and outcome of each tool it ran.
Everything is recorded; settings only decide what is shown, so a change applies
to stamps already on screen, including tools that ran while `toolStamps` was off.
Entries written by every earlier version of the fork still render.

## Keys

- `Ctrl+O` (Pi's expand tool output) adds exact ISO and unix-ms times when
  `showExactTimeline` is on, and response ids and diagnostics under metadata.

## `rig.json` settings (`stamp` section)

Edit with `/rig`; there is no `/stamp` command.

| Key | Default | Meaning |
|---|---|---|
| `hourCycle` | `24h` | `24h` or `12h` |
| `showSeconds` | `true` | Show seconds |
| `dateContext` | `day-change` | Show the date on a day change, `always` or `never` |
| `locale` | `invariant` | `invariant` (`2026-09-23 · 14:05:09`), `system`, or a BCP 47 tag such as `de-DE` |
| `timeZone` | `local` | `local` or an IANA zone such as `Asia/Kolkata` |
| `responseTiming` | `off` | `duration`, or `detailed` (time to first content and total) |
| `assistantMetadata` | `off` | Model, tokens and cost: `compact` (one line) or `expanded` |
| `showExactTimeline` | `true` | Exact times when output is expanded |
| `showThinkingLevel` | `true` | Thinking level in metadata |
| `showCompactAbnormalOutcome` | `true` | Stop reasons such as `length` in compact metadata |
| `showCostSinceUser` | `false` | Cost since your last message |
| `toolStamps` | `false` | `tool <name> · <duration> · <outcome>` for each tool |

The `/rig` menu cycles `locale` and `timeZone` through their named values; set a
tag or zone in `rig.json` and `/reload`.

On first run, when `rig.json` has no `stamp` section, valid values are imported
once from the old fork's `pi-stamp.json`. That file is never written.
