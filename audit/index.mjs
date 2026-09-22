// Runtime audit: launches pi with audit/probe.ts, records what it registers
// (tools, commands, skills, models, system prompt), and prints token costs.
//
//   npm run audit                  CI gate: this package alone in a hermetic
//                                  sandbox (clean HOME + config, offline, empty
//                                  cwd). Fails on crash, missing shutdown, or
//                                  prompt tokens over budgets.json.
//   npm run audit -- --live        Report only: your real ~/.pi install as it
//                                  loads today. Exits at session_start, so no
//                                  model call is made.
//   add --json                     Print the raw report (diff before/after).
//
// Pi resolution (CI): $PI_AUDIT_PI_BIN, else `pi` on PATH when its version
// matches the pin, else `npx -y <pinned pi>`. Live mode uses `pi` on PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gate, report } from "./checks.mjs";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const TIMEOUT_MS = 120_000;
const live = process.argv.includes("--live");
const asJson = process.argv.includes("--json");

const budgets = JSON.parse(readFileSync(join(REPO_ROOT, "audit", "budgets.json"), "utf8"));
const versionOf = (bin) => {
  const r = spawnSync(bin[0], [...bin.slice(1), "--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").pop().trim() : null;
};
function resolvePiBin() {
  if (live) return ["pi"];
  if (process.env.PI_AUDIT_PI_BIN) return process.env.PI_AUDIT_PI_BIN.split(" ");
  if (versionOf(["pi"]) === budgets.piVersion) return ["pi"];
  return ["npx", "-y", `@earendil-works/pi-coding-agent@${budgets.piVersion}`];
}

function runPi(bin, args, env, cwd) {
  return new Promise((done) => {
    const child = spawn(bin[0], [...bin.slice(1), ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", () => {});
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, timedOut, stderr });
    });
  });
}

const bin = resolvePiBin();
const version = versionOf(bin);
if (!live && version !== budgets.piVersion) {
  console.error(`audit FAILED: pi ${version} != pinned ${budgets.piVersion}`);
  process.exit(1);
}

// Empty cwd under tmpdir: no project .pi/ or .agents/ can leak in.
const box = mkdtempSync(join(tmpdir(), "pi-audit-"));
const cwd = join(box, "cwd");
mkdirSync(cwd);
const snapPath = join(box, "snapshot.json");
const shutdownMarker = join(box, "shutdown");
const env = { ...process.env, PI_AUDIT_SNAP: snapPath };
if (live) {
  env.PI_AUDIT_EXIT = "1";
} else {
  const home = join(box, "home");
  const config = join(box, "config");
  mkdirSync(home);
  mkdirSync(config);
  writeFileSync(join(config, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
  Object.assign(env, {
    HOME: home,
    PI_CODING_AGENT_DIR: config,
    PI_OFFLINE: "1",
    PI_AUDIT_SHUTDOWN_MARKER: shutdownMarker,
    NPM_CONFIG_CACHE: join(homedir(), ".npm", "_cacache"),
  });
}

const run = await runPi(
  bin,
  ["-p", "--no-session", "-e", join(REPO_ROOT, "audit", "probe.ts"), "--", "audit snapshot probe"],
  env,
  cwd,
);
const snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, "utf8")) : null;
const shutdownObserved = existsSync(shutdownMarker);
rmSync(box, { recursive: true, force: true });

if (!snap) {
  console.error(`audit FAILED: probe wrote no snapshot (exit ${run.exitCode}, timedOut ${run.timedOut})\n${run.stderr}`);
  process.exit(1);
}

const r = report(snap);
if (asJson) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`pi ${version} (${live ? "live ~/.pi install" : "this package, hermetic"})`);
  console.log(`tokens ~${r.totalTokens}: system prompt ${r.systemPromptTokens} + tools ${r.toolTokens}`);
  console.log(`tools ${r.tools.length}, commands ${r.commands}, skills ${r.skills}, models ${r.models}`);
  if (r.duplicateModels.length > 0) console.log(`duplicate models: ${r.duplicateModels.join(", ")}`);
  for (const t of r.tools) console.log(`  ${String(t.tokens).padStart(5)}  ${t.name}  (${t.source})`);
}

if (live) process.exit(0);
const failures = gate(snap, { timedOut: run.timedOut, shutdownObserved }, budgets);
for (const f of failures) console.error(`audit FAILED: ${f}`);
process.exit(failures.length > 0 ? 1 : 0);
