# stamp

Right-aligned timestamps under each message in the transcript, with optional
response timing, model metadata, cost and tool durations. Ported from the local
fork of [`@narumitw/pi-stamp`](https://www.npmjs.com/package/@narumitw/pi-stamp)
0.51.0 (MIT) for spec [#36](https://github.com/aakshintala/pi-rig/issues/36).

It registers no tools and no commands.

## What it records

In TUI sessions, every user message and every response gets a `pi-stamp` session
entry. A response's entry records its timing, model metadata, thinking level,
cost since your last message and the duration and outcome of each tool it ran.
Everything is recorded; settings only decide what is shown, and a change applies
to stamps already on screen, including tools that ran while `toolStamps` was
off. Entries written by every earlier version of the fork still render.

## Tool-only responses

A response with tool calls and no text draws nothing in the chat, so its stamp
draws no row either. That includes one that was aborted or failed; a `length`
stop keeps its row, under Pi's truncation line. A collapsed run of tool calls
therefore has one stamp, under the reply that ends it. That stamp's response
time totals the whole run, from the first tool-only response, and its date
context skips the hidden stamps.

- `toolStamps` on brings their rows back, each with its tool durations.
- Pi gives extensions no way to redraw the chat, so a `toolStamps` change
  reaches these rows only when Pi rebuilds the chat (`/reload`, `/resume`,
  `/tree`, compaction). Turning it off blanks their text at once but leaves one
  blank row each until then.
- Pi does not tell extensions whether thinking is shown, so the rule looks at
  text only: a tool-only response whose thinking you show with `Ctrl+T` gets no
  row either.

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

In `/rig`, press `e` on `locale` or `timeZone` to type a tag or zone; Enter
cycles the named values and the last typed one.

At the first session start with a `pi-stamp.json` from the old fork, its valid
values are imported in one write, unless `rig.json` already has a `stamp`
section. POSIX locales such as `en_US.UTF-8` become `en-US`. The marker file
`rig-stamp-imported` beside `rig.json` stops later imports; `pi-stamp.json` is
never written.
