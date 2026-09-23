# search

`grep` and `find` under Pi's built-in names, served by the
[FFF](https://github.com/dmtrKovalenko/fff) native index through
`@ff-labs/fff-node` (pinned). Pi's `@` file autocomplete is left alone.

## Tools

- `grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })`:
  the built-in's parameters and output format. Smart case unless `ignoreCase`
  is set (`false` means case-sensitive). Respects `.gitignore`; `.git/` is
  never searched. Whitespace in a regex is sent to FFF hex-encoded, so an
  extended-mode `(?x)` pattern matches its spaces literally instead of
  ignoring them.
- `find({ pattern, path?, limit? })`: a pattern with `*`, `?`, `[` or `{` is a
  glob, matched at any depth like the built-in; other text is a fuzzy name
  search, returned in FFF's ranking up to `limit`. Git-changed and
  frequently used files rank first. `path` scopes the search inside FFF, before
  ranking. Files only, no directories.

## Index

One index per session, for the session's working directory, built in the
background from `session_start` and kept current by FFF's file watcher. A
search waits up to 5 s for the binding to load and the first scan to finish;
cancelling the call ends the wait. Frecency lives in
`<agent dir>/fff/frecency`. The index is destroyed on shutdown, `/reload` and
session switch; a search still waiting for it then falls back.

## Fallback

The built-in `grep` and `find` run instead, with a one-time warning, when:

- FFF's native library is missing or fails to load
- FFF cannot create the index (a failing frecency database only costs ranking)
- the session starts in `$HOME` or `/` (symlinks resolved)
- loading and the first scan take over 5 s (that call only)
- a path lies outside the working directory, or holds glob characters

## Parity

`tests/search-parity.test.mjs` runs fixture queries through both
implementations and compares the lines up to ordering, using real `rg` and
`fd` (CI installs `ripgrep` and `fd-find`). Two known differences are
deliberate: the built-in greps `.git/` internals, and rooted globs such as
`src/**/*.ts` match nothing in the built-in `grep`.

No commands, keys or `rig.json` settings.
