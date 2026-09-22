// Runtime audit harness: launches pi against this package in a hermetic
// sandbox (clean HOME + config, offline, empty cwd) and records externally
// observable registration state, then enforces the budgets in budgets.json
// against the committed baseline in baseline.json.
//
//   npm run audit                   capture live snapshot, enforce budgets
//   npm run audit -- --update-baseline   recapture and rewrite baseline.json
//
// Pi resolution: $PI_AUDIT_PI_BIN, else `pi` on PATH when its version
// matches the pin, else `npx -y <pinned pi>` (credential-free either way;
// the audited run performs no model call, so no providers are needed).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAll, estimatePromptTokens } from "./checks.mjs";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const TIMEOUT_MS = 120_000;

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const piVersionOf = (bin, args = ["--version"]) => {
  const r = spawnSync(bin[0], [...bin.slice(1), ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").pop().trim() : null;
};

function resolvePiBin(pin) {
  if (process.env.PI_AUDIT_PI_BIN) return process.env.PI_AUDIT_PI_BIN.split(" ");
  const onPath = piVersionOf(["pi"]);
  if (onPath === pin) return ["pi"];
  return ["npx", "-y", `${PI_PACKAGE}@${pin}`];
}

const CONFIG_GUARD = ".pi";

// Fail loudly if the sandbox could inherit ambient project resources.
function assertHermeticCwd(dir) {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, ".agents", "skills")) || existsSync(join(cur, CONFIG_GUARD))) {
      throw new Error(`sandbox ${dir} inherits project resources from ${cur}; refusing`);
    }
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

function runPi(bin, args, env) {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(bin[0], [...bin.slice(1), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, durationMs: Date.now() - start, timedOut });
    });
  });
}

const budgets = load(join(REPO_ROOT, "audit", "budgets.json"));
const updateBaseline = process.argv.includes("--update-baseline");
const bin = resolvePiBin(budgets.piVersion);
const observedBinVersion = piVersionOf(bin);
console.log(`audit: pi via \`${bin.join(" ")}\` (version ${observedBinVersion ?? "unknown"})`);

const box = mkdtempSync(join(tmpdir(), "pi-audit-"));
const homeDir = join(box, "home");
const configDir = join(box, "config");
const cwdDir = join(box, "cwd");
for (const d of [homeDir, configDir, cwdDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(configDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
assertHermeticCwd(cwdDir);

const snapPath = join(box, "snapshot.json");
const shutdownMarker = join(box, "shutdown");
const env = {
  ...process.env,
  HOME: homeDir,
  PI_CODING_AGENT_DIR: configDir,
  PI_OFFLINE: "1",
  PI_AUDIT_SNAP: snapPath,
  PI_AUDIT_SHUTDOWN_MARKER: shutdownMarker,
  NPM_CONFIG_CACHE: join(homedir(), ".npm", "_cacache"),
};

const { exitCode, durationMs, timedOut } = await runPi(
  bin,
  ["-p", "--no-session", "-e", join(REPO_ROOT, "audit", "probe.ts"), "--", "audit snapshot probe"],
  env,
);

let snapshot = null;
let snapshotError = null;
try {
  if (!existsSync(snapPath)) throw new Error("probe wrote no snapshot (pi failed before session_start?)");
  if (Date.now() - statSync(snapPath).mtimeMs > TIMEOUT_MS) throw new Error("snapshot is stale");
  snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
} catch (e) {
  snapshotError = String(e?.message ?? e);
}

const shutdownObserved = existsSync(shutdownMarker);

rmSync(box, { recursive: true, force: true });

if (snapshotError) {
  console.error(`audit FAILED: ${snapshotError} (exit ${exitCode}, ${durationMs}ms)`);
  process.exit(1);
}
snapshot.piVersion = observedBinVersion;
snapshot.lifecycle = {
  exitCode,
  durationMs,
  timedOut,
  shutdownObserved,
  promptTokens: estimatePromptTokens(snapshot),
};

if (updateBaseline) {
  const baseline = {
    piVersion: observedBinVersion,
    capturedAt: new Date().toISOString(),
    activeTools: snapshot.activeTools,
    allTools: snapshot.allTools,
    commands: snapshot.commands,
    models: snapshot.models,
    systemPrompt: snapshot.systemPrompt,
  };
  writeFileSync(join(REPO_ROOT, "audit", "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
  console.log("audit: baseline.json rewritten; re-run without --update-baseline to enforce.");
  process.exit(0);
}

const baseline = load(join(REPO_ROOT, "audit", "baseline.json"));
const { results, failures } = runAll({ ...snapshot, lifecycle: undefined }, baseline, budgets, REPO_ROOT);
for (const [name, r] of Object.entries(results)) console.log(`audit: [${r.ok ? "ok" : "FAIL"}] ${name}: ${r.detail}`);
console.log(`audit: lifecycle exit=${exitCode} time=${durationMs}ms timedOut=${timedOut} shutdown=${shutdownObserved} tokens~${snapshot.lifecycle.promptTokens}`);
if (timedOut) failures.push("lifecycle-timeout");
if (!shutdownObserved) failures.push("lifecycle-shutdown");
if (failures.length > 0) {
  console.error(`audit FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("audit ok");
