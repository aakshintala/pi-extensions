// node analyze.mjs out/rig [out/base]
// Aggregates a sampled heap profile. "self" = allocating frame; "rig" = each sample
// charged to its nearest repo (non-node_modules) frame on the stack, so allocations made
// inside pi-tui on behalf of rig code count against the rig line that asked for them.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = (process.env.ALLOC_REPO ?? resolve(HERE, "../..")) + "/"; // bench/alloc -> repo root
const isRig = (u) => u.includes(REPO) && !u.includes("/node_modules/");
const short = (u) => u.replace("file://", "").replace(REPO, "").replace(/.*node_modules\//, "nm:");
const MB = (b) => (b / 1e6).toFixed(1);

function load(name) {
  const p = JSON.parse(readFileSync(`${name}.heapprofile`));
  const s = JSON.parse(readFileSync(`${name}.json`));
  const self = new Map(), rig = new Map(), rigFile = new Map(), rigFn = new Map(), selfFile = new Map();
  let total = 0, rigTotal = 0;
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  (function walk(n, stack) {
    const f = n.callFrame;
    const key = `${short(f.url)}:${f.lineNumber + 1} ${f.functionName || "(anon)"}`;
    const next = isRig(f.url) ? [...stack, key] : stack;
    total += n.selfSize;
    add(self, key, n.selfSize);
    add(selfFile, short(f.url) || "(native/unknown)", n.selfSize);
    if (next.length) {
      rigTotal += n.selfSize;
      const r = next.at(-1);
      add(rig, r, n.selfSize);
      add(rigFile, r.split(":")[0], n.selfSize);
      // outermost rig frame: the entry point (event handler / renderer) that led here
      add(rigFn, next[0], n.selfSize);
    }
    for (const c of n.children) walk(c, next);
  })(p.head, []);
  return { s, self, rig, rigFile, rigFn, selfFile, total, rigTotal };
}

const top = (m, n, total) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${MB(v).padStart(8)} MB ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`).join("\n");
const [a, b] = process.argv.slice(2).map(load);
for (const [name, r] of [["RUN", a], ["BASE", b]]) {
  if (!r) continue;
  const s = r.s;
  console.log(`\n=== ${name}: ${s.turns} turns, ${s.chunks} chunks, ${s.frames} stdout writes, ${s.seconds}s`);
  console.log(`allocated ${MB(s.totalAllocated)} MB = ${MB(s.totalAllocated / s.turns)} MB/turn, ${(s.totalAllocated / s.chunks / 1e3).toFixed(1)} KB/chunk; gcs ${JSON.stringify(s.gcs)}`);
  console.log(`heap after GC: ${s.heap.map((h) => `t${h.turn}=${MB(h.heapUsed)}`).join(" ")}`);
  console.log(`sampled total ${MB(r.total)} MB; with a rig frame on stack ${MB(r.rigTotal)} MB (${((100 * r.rigTotal) / r.total).toFixed(1)}%)`);
}
console.log("\n--- rig: nearest rig frame (line) ---\n" + top(a.rig, 40, a.rigTotal));
console.log("\n--- rig: by file ---\n" + top(a.rigFile, 20, a.rigTotal));
console.log("\n--- rig: outermost rig frame (entry) ---\n" + top(a.rigFn, 20, a.rigTotal));
console.log("\n--- run: self by file ---\n" + top(a.selfFile, 25, a.total));
if (b) console.log("\n--- base: self by file ---\n" + top(b.selfFile, 25, b.total));
// Per-turn trend: bytes per turn over the run in buckets of 25.
for (const [name, r] of [["RUN", a], ["BASE", b]]) {
  if (!r) continue;
  const t = r.s.turnsDetail, out = [];
  for (let i = 0; i < t.length; i += 25) {
    const g = t.slice(i, i + 25);
    const bytes = g.reduce((n, x) => n + x.bytes, 0), ch = g.reduce((n, x) => n + x.chunks, 0);
    out.push(`t${i + 1}-${i + g.length}: ${MB(bytes / g.length)} MB/turn ${(bytes / ch / 1e3).toFixed(0)} KB/chunk`);
  }
  console.log(`\n${name} trend: ${out.join(" | ")}`);
}
