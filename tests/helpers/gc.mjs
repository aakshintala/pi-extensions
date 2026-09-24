// Shared GC-forcing helper for retention tests, the same trick #154's tool-display
// test uses: Node only exposes `gc()` when --expose-gc is passed at startup, so this
// flips the flag at runtime and runs a throwaway one in a fresh vm context.
//
// Call it after dropping the references you want collected. WeakRefs clear only after
// the current microtask queue drains, so `await new Promise((r) => setImmediate(r));`
// first.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

export function forceGC() {
  setFlagsFromString("--expose-gc");
  runInNewContext("gc")();
}
