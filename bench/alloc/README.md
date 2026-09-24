# Allocation harness

Measures what the rig's extensions add to Pi's per-turn heap allocation and
GC pressure. Drives a real interactive `pi` in a private tmux pane through
34 scripted prompts (edits, greps, tool calls) under a sampling heap
profiler, then aggregates the profile by which repo line the allocation
traces back to.

Manual only: run it before merging a render-path change, not in CI. It
launches a real `pi`, takes minutes, and its output is a diff you read, not
a pass/fail gate.

## Run

```sh
npm run bench:alloc -- rig rig      # extensions loaded
npm run bench:alloc -- base base    # bare pi, no rig extensions, for comparison
node bench/alloc/analyze.mjs bench/alloc/out/rig bench/alloc/out/base
```

`analyze.mjs` prints allocation totals, MB/turn, GC counts, and the
top allocating rig call sites and files.

`bench/alloc/childrig/harness.mjs` is a separate, standalone script that
measures per-child memory and hook cost when the rig spawns subagents
(`WT=<worktree> N=4 node --expose-gc bench/alloc/childrig/harness.mjs`).

Every run must go through `timeout`, with `--max-old-space-size` on any node
process it launches — `npm run bench:alloc` already bakes both in; wrap
direct `node` invocations (e.g. `analyze.mjs`, `childrig/harness.mjs`) the
same way. Kill the harness's private tmux server (`tmux -L pi-alloc-<pid>
kill-server`) if a run is interrupted; `run.mjs` does this itself on a clean
exit.

`ALLOC_REPO` overrides the repo root the harness resolves scripts and
extensions against (defaults to this checkout).
