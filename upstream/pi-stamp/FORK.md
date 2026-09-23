# pi-stamp fork

Local fork of `@narumitw/pi-stamp@0.51.0`, vendored because the upstream
version caused multi-GiB memory growth in long TUI sessions.

## Why

Upstream `src/format.ts` built a fresh `Intl.DateTimeFormat` on every
`zonedParts()` call (3 per stamp with default `day-change`), and
`src/stamp.ts` recomputed every stamp label on every TUI frame with no
memoization. A 341-stamp session created ~1,000 ICU formatters per frame.

## Fixes (vs 0.51.0)

- `src/format.ts`: module-level `Intl.DateTimeFormat` cache keyed by
  locale/time-zone/options. Steady state: 0 new formatters per render.
- `src/stamp.ts`: stamp lines recomputed only when settings change
  (entries are immutable); wrapped output reused until width changes;
  `invalidate()` actually clears the caches.

## Compatibility

- Same entry type (`pi-stamp`) and same settings file (`pi-stamp.json`),
  so existing sessions keep working.
- `node_modules/@narumitw/pi-tui-kit` is a vendored copy of 0.59.0, so the
  fork is self-contained and immune to upstream uninstalls/prunes.

## Refreshing from upstream

Diff `src/` against the installed `npm:@narumitw/pi-stamp` copy and
re-apply the `ponytail:` blocks (`formatterCache` in `format.ts`,
`settingsSignature`/`memoizeStampLines`/width memo in `stamp.ts`).
