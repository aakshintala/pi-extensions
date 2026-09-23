---
name: ponytail-audit
description: >
  Whole-repo audit for over-engineering: a ranked list of what to delete,
  simplify, or replace with stdlib or native equivalents. Use when the user
  asks to audit a codebase for bloat or what can be deleted from a repo.
  Reports only; applies nothing.
---

<!-- Adapted from DietrichGebert/ponytail 4.10.0 (MIT, see LICENSE); origin in upstream/ponytail/SOURCE. -->

Scan the whole tree for over-engineering. Rank findings biggest cut first.

## Tags

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Hunt

Deps the stdlib or platform already ships, single-implementation interfaces,
factories with one product, wrappers that only delegate, files exporting one
thing, dead flags and config, hand-rolled stdlib.

## Output

One line per finding, ranked: `<tag> <what to cut>. <replacement>. [path]`.
End with `net: -<N> lines, -<M> deps possible.` Nothing to cut: `Lean already. Ship.`

## Scope

Over-engineering and complexity only. Send correctness bugs, security holes
and performance to a normal review. List findings; leave the code unchanged.
