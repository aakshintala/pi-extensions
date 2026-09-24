// Loaded with `node --expose-gc --import preload.mjs <pi cli>`.
// Samples allocations (including objects later collected, so churn shows), and exposes
// globalThis.__alloc for the harness extension to mark turns/chunks and finish the run.
import inspector from "node:inspector";
import v8 from "node:v8";
import { writeFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";

const OUT = process.env.ALLOC_OUT;
const INTERVAL = Number(process.env.ALLOC_INTERVAL ?? 16384);
const GC_EVERY = Number(process.env.ALLOC_GC_EVERY ?? 25);
const session = new inspector.Session();
session.connect();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
// Sampling starts at begin(), after startup (module loading, jiti) is done.
const startSampling = async () => {
  if (process.env.ALLOC_PROFILE === "0") return;
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", {
    samplingInterval: INTERVAL,
    // ALLOC_RETAINED=1: only objects still alive at finish (retention by allocation site).
    includeObjectsCollectedByMajorGC: process.env.ALLOC_RETAINED !== "1",
    includeObjectsCollectedByMinorGC: process.env.ALLOC_RETAINED !== "1",
  });
};

const gcs = { minor: 0, major: 0, other: 0, ms: 0 };
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const k = e.detail?.kind;
    if (k === 1) gcs.minor++; // NODE_PERFORMANCE_GC_MINOR
    else if (k === 4) gcs.major++; // NODE_PERFORMANCE_GC_MAJOR
    else gcs.other++;
    gcs.ms += e.duration;
  }
}).observe({ entryTypes: ["gc"] });

// Frames: every TUI render ends in a stdout write.
let writes = 0, writeBytes = 0;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  writes++;
  writeBytes += chunk?.length ?? 0;
  return write(chunk, ...rest);
};

const allocated = () => v8.getHeapStatistics().total_allocated_bytes;
const retained = (label) => {
  globalThis.gc();
  globalThis.gc();
  const h = v8.getHeapStatistics();
  return { label, heapUsed: h.used_heap_size, external: h.external_memory, rss: process.memoryUsage.rss() };
};

const state = { turns: [], heap: [], chunks: 0, updates: 0, start: 0, startAt: 0 };
let last = { a: 0, chunks: 0, writes: 0, updates: 0 };

globalThis.__alloc = {
  async begin() {
    await startSampling();
    state.heap.push({ turn: 0, ...retained("turn 0") });
    state.startAt = Date.now();
    state.start = allocated();
    last = { a: state.start, chunks: 0, writes, updates: 0 };
  },
  chunk() { state.chunks++; },
  update() { state.updates++; },
  turn() {
    const a = allocated();
    const n = state.turns.length + 1;
    state.turns.push({ turn: n, bytes: a - last.a, chunks: state.chunks - last.chunks, updates: state.updates - last.updates, frames: writes - last.writes });
    if (n % GC_EVERY === 0) state.heap.push({ turn: n, ...retained(`turn ${n}`) });
    last = { a: allocated(), chunks: state.chunks, writes, updates: state.updates };
  },
  async finish() {
    const total = allocated() - state.start;
    const summary = {
      turns: state.turns.length,
      totalAllocated: total,
      chunks: state.chunks,
      updates: state.updates,
      frames: state.turns.reduce((n, t) => n + t.frames, 0),
      stdoutBytes: writeBytes,
      seconds: (Date.now() - state.startAt) / 1000,
      gcs,
      heap: state.heap,
      turnsDetail: state.turns,
    };
    if (process.env.ALLOC_PROFILE !== "0") {
      if (process.env.ALLOC_RETAINED === "1") { globalThis.gc(); globalThis.gc(); }
      const { profile } = await post("HeapProfiler.stopSampling");
      writeFileSync(`${OUT}.heapprofile`, JSON.stringify(profile));
    }
    writeFileSync(`${OUT}.json`, JSON.stringify(summary, null, 1));
    process.exit(0);
  },
};
