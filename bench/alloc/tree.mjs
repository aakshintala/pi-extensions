// node tree.mjs out/rig "<url-substring>:<line>"  — callee breakdown (self frames) under a frame
import { readFileSync } from "node:fs";
const [file, target] = process.argv.slice(2);
const p = JSON.parse(readFileSync(`${file}.heapprofile`));
const sh = (f) => `${f.url.replace(/.*node_modules\//, "").replace(/.*pi-extensions\//, "")}:${f.lineNumber + 1} ${f.functionName || "anon"}`;
const self = new Map(), paths = new Map(), callers = new Map(); let tot = 0;
(function w(n, st) {
  const k = sh(n.callFrame); const ns = [...st, k];
  const i = ns.findIndex((x) => x.includes(target));
  if (i >= 0) {
    tot += n.selfSize;
    self.set(k, (self.get(k) ?? 0) + n.selfSize);
    const path = ns.slice(i, i + 5).join(" > ");
    paths.set(path, (paths.get(path) ?? 0) + n.selfSize);
    const c = ns.slice(Math.max(0, i - 4), i).join(" > ");
    callers.set(c, (callers.get(c) ?? 0) + n.selfSize);
  }
  n.children.forEach((c) => w(c, ns));
})(p.head, []);
const t = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k, v]) => console.log((v / 1e6).toFixed(0).padStart(7), k));
console.log("total under", target, (tot / 1e6).toFixed(0), "MB\nSELF"); t(self, 15);
console.log("PATHS"); t(paths, 12); console.log("CALLERS"); t(callers, 6);
