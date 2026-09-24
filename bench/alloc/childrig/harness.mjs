// Measures what N subagent children cost with the full rig loaded.
//   WT=<worktree> N=4 node --expose-gc harness.mjs
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WT = realpathSync(process.env.WT);
const N = Number(process.env.N ?? 4);
const TREE = process.env.TREE ?? new URL("./tree", import.meta.url).pathname;
const NM = realpathSync(join(WT, "node_modules"));
const imp = (p) => import(pathToFileURL(p).href);

// ---- attribution by stack ----
const where = () => {
  const s = new Error().stack.split("\n").slice(3).join("\n");
  const m = s.match(/\/(extensions|shared)\/([\w-]+)\//);
  if (m) return `${m[1] === "shared" ? "shared/" : ""}${m[2]}`;
  if (s.includes("pi-coding-agent")) return "pi";
  return "other";
};
let recording = false;
const counts = {};
const bump = (kind, k = where()) => {
  if (!recording) return;
  (counts[k] ??= {})[kind] = (counts[k][kind] ?? 0) + 1;
};
for (const name of ["readFileSync", "readdirSync", "statSync", "existsSync", "watch", "watchFile", "readFile", "readdir"]) {
  const real = fs[name];
  fs[name] = function (...a) {
    bump(name);
    return real.apply(this, a);
  };
}
for (const name of ["readFile", "readdir", "stat"]) {
  const real = fs.promises[name];
  fs.promises[name] = function (...a) {
    bump(`promises.${name}`);
    return real.apply(this, a);
  };
}
syncBuiltinESMExports();
for (const name of ["setInterval", "setTimeout"]) {
  const real = globalThis[name];
  globalThis[name] = function (fn, ms, ...a) {
    bump(name === "setInterval" ? `setInterval(${ms})` : "setTimeout");
    return real.call(this, fn, ms, ...a);
  };
}

// ---- FFF ----
const fff = await imp(join(NM, "@ff-labs/fff-node/dist/index.js"));
const finders = [];
const realCreate = fff.FileFinder.create.bind(fff.FileFinder);
fff.FileFinder.create = (o) => {
  const r = realCreate(o);
  if (r.ok) finders.push({ f: r.value, root: o.basePath, at: performance.now() });
  return r;
};

await imp(join(WT, "tests/fixtures/tool-display/pi-tui.mjs"));
const pca = await imp(join(NM, "@earendil-works/pi-coding-agent/dist/index.js"));
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await imp(join(NM, "@earendil-works/pi-ai/dist/index.js"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, ExtensionRunner } = pca;

// ---- hook firing per runner ----
let parentRunner;
const hooks = []; // { child, ext, event, ms }
const wrapped = new WeakSet();
const childRunners = new Set();
const realCtx = ExtensionRunner.prototype.createContext;
ExtensionRunner.prototype.createContext = function (...a) {
  if (!wrapped.has(this)) {
    wrapped.add(this);
    for (const ext of this.extensions) {
      const name = ext.path.match(/extensions\/([\w-]+)\//)?.[1] ?? ext.path.split("/").pop();
      for (const [event, list] of ext.handlers) {
        list.forEach((h, i) => {
          list[i] = async (e, c) => {
            const t = performance.now();
            try {
              return await h(e, c);
            } finally {
              if (recording) hooks.push({ child: this !== parentRunner, runner: this, ext: name, event, ms: performance.now() - t });
            }
          };
        });
      }
    }
  }
  if (this !== parentRunner && parentRunner) childRunners.add(this);
  return realCtx.apply(this, a);
};

// ---- session ----
const box = realpathSync(mkdtempSync(join(tmpdir(), "childrig-")));
const home = join(box, "home");
const agentDir = join(box, "agent");
const cwd = join(box, "cwd");
for (const d of [home, agentDir]) mkdirSync(d);
execSync(`cp -Rc ${JSON.stringify(TREE)} ${JSON.stringify(cwd)}`);
Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });

const exts = [join(WT, "tests/fixtures/subagents/kid.ts"), ...readdirSync(join(WT, "extensions")).filter((d) => fs.existsSync(join(WT, "extensions", d, "index.ts"))).map((d) => join(WT, "extensions", d, "index.ts"))];
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: exts }));

const t = {};
const kid = {};
let release;
const hold = new Promise((r) => (release = r));
let grepped = 0;
let allGrepped;
const everyoneGrepped = new Promise((r) => (allGrepped = r));
globalThis[Symbol.for("pi-rig.test.kid")] = async (context) => {
  const first = context.messages.find((m) => m.role === "user");
  const task = (typeof first.content === "string" ? first.content : first.content.map((c) => c.text ?? "").join("")).split("\n\nEnd your final message")[0];
  const k = (kid[task] ??= { calls: [] });
  k.calls.push(performance.now());
  if (k.calls.length === 1) return fauxAssistantMessage([fauxToolCall("grep", { pattern: "createAgentSession", limit: 5 })], { stopReason: "toolUse" });
  if (k.calls.length === 2) {
    if (++grepped === N) allGrepped();
    await hold;
  }
  return fauxAssistantMessage(fauxText(`done ${task}`));
};

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const spawn = (i) => fauxToolCall("subagent_spawn", { description: `child ${i}`, prompt: `task ${i}`, model: "kid/kid-1", thinking: "low", isolation: "none" });
faux.setResponses([
  () => ((t.spawn = performance.now()), N ? fauxAssistantMessage(Array.from({ length: N }, (_, i) => spawn(i)), { stopReason: "toolUse" }) : fauxAssistantMessage(fauxText("nothing"))),
  fauxAssistantMessage(fauxText("spawned")),
  fauxAssistantMessage(fauxText("waiting")),
  fauxAssistantMessage(fauxText("waiting")),
  fauxAssistantMessage(fauxText("waiting")),
]);
const creds = new Map();
const modelRuntime = await ModelRuntime.create({
  credentials: { read: async (id) => creds.get(id), list: async () => [], modify: async (id, fn) => { const n = await fn(creds.get(id)); if (n !== undefined) creds.set(id, n); return n; }, delete: async (id) => void creds.delete(id) },
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);
globalThis[Symbol.for("pi-rig.subagents.modelRuntime")] = modelRuntime;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: exts, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await resourceLoader.reload();
console.error("loaded", performance.now()|0);
const { session } = await createAgentSession({
  cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, settingsManager,
  sessionManager: SessionManager.create(cwd, join(box, "sessions")),
  tools: ["read", "bash", "grep", "find", "subagent_spawn", "subagent_message", "subagent_stop"],
});
parentRunner = session.extensionRunner;
console.error("created", performance.now()|0);
await session.bindExtensions({});
console.error("bound", performance.now()|0);
// Let the parent's own index finish.
await finders[0]?.f.waitForScan(30_000);
await new Promise((r) => setTimeout(r, 1500));

const threads = () => Number(execSync(`ps -M -p ${process.pid} | wc -l`).toString().trim()) - 1;
const mem = () => {
  global.gc?.();
  global.gc?.();
  const m = process.memoryUsage();
  return { rss: m.rss / 2 ** 20, heap: m.heapUsed / 2 ** 20, external: m.external / 2 ** 20, threads: threads() };
};
const before = mem();
console.error("scanned", performance.now()|0);
const findersBefore = finders.length;
recording = true;
let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss / 2 ** 20)), 25);
setInterval(() => console.error("fleet", JSON.stringify((globalThis[Symbol.for("pi-rig.fleet")]?.items() ?? []).map((i) => [i.status, i.result])), "kid", JSON.stringify(Object.values(kid).map((k) => k.calls.length)), JSON.stringify(session.messages.slice(-4).map((m) => JSON.stringify(m.content).slice(0, 300)))), 5000).unref();
const prompted = session.prompt("go");
console.error("prompted", performance.now()|0);
let alive;
if (N) {
  await everyoneGrepped;
  alive = mem();
console.error("alive", performance.now()|0);
  release();
}
await prompted;
const g = globalThis[Symbol.for("pi-rig.fleet")];
const deadline = Date.now() + 60_000;
while (N && g.items().some((i) => !["done", "failed", "stopped"].includes(i.status)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 500));
recording = false;
clearInterval(sampler);
const after = mem();

const kids = Object.values(kid);
const firstMs = kids.map((k) => k.calls[0] - t.spawn);
const grepMs = kids.map((k) => k.calls[1] - k.calls[0]);
const childFinders = finders.slice(findersBefore);
const byExt = {};
for (const h of hooks.filter((h) => h.child)) {
  const e = (byExt[h.ext] ??= {});
  const x = (e[h.event] ??= { n: 0, ms: 0 });
  x.n++;
  x.ms += h.ms;
}
for (const e of Object.values(byExt)) for (const x of Object.values(e)) x.ms = +x.ms.toFixed(1);
const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(1) : v]));
console.log(JSON.stringify({
  N,
  childRunners: childRunners.size,
  finders: { total: finders.length, byChildren: childFinders.length, destroyedAfterChildren: childFinders.filter((f) => f.f.isDestroyed).length, roots: [...new Set(childFinders.map((f) => f.root))].length },
  mem: { before: r(before), allAlive: alive && r(alive), after: r(after), peakRss: +peakRss.toFixed(1) },
  perChild: alive && { rss: +((alive.rss - before.rss) / N).toFixed(1), heap: +((alive.heap - before.heap) / N).toFixed(1), external: +((alive.external - before.external) / N).toFixed(1), threads: (alive.threads - before.threads) / N },
  firstResponseMs: firstMs.map((x) => Math.round(x)),
  childGrepMs: grepMs.map((x) => Math.round(x)),
  childHooks: byExt,
  sideEffects: counts,
}, null, 1));

await parentRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
await new Promise((r) => setTimeout(r, 300));
console.error(`finders alive at exit: ${finders.filter((f) => !f.f.isDestroyed).length}/${finders.length}`);
rmSync(box, { recursive: true, force: true });
process.exit(0);
