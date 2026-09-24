// node run.mjs <rig|base> <outName> [--cli bundle|dist] [--no-profile] [--exclude a,b]
// Runs a real interactive pi in a private tmux pane (120x40) under preload.mjs, with the
// harness extension driving PROMPTS prompts, and waits for <outName>.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.ALLOC_REPO ?? resolve(HERE, "../.."); // bench/alloc -> repo root
const PKG = join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist");
const [mode = "rig", name = mode, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const CLI = opt("--cli") === "bundle" ? join(PKG, "bundle/cli.js") : join(PKG, "cli.js");
const exclude = (opt("--exclude") ?? "").split(",").filter(Boolean);
const OUT = join(HERE, "out", name);
mkdirSync(join(HERE, "out"), { recursive: true });
for (const s of [".json", ".heapprofile"]) rmSync(OUT + s, { force: true });

const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-alloc-")));
const home = join(box, "home"), cwd = join(home, "cwd"), agentDir = join(box, "agent");
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "tui.editor.cursorLeft": ["left"] }));

// Workspace: FILES code-like files of 2-20KB, file m % FILES holds `// MARK_m` lines for edits.
const FILES = 40;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let f = 0; f < FILES; f++) {
  const size = 2000 + Math.floor(rnd() * 18000);
  let s = `// file ${f}\n`;
  for (let m = f; m < 200; m += FILES) s += `// MARK_${m}\n`;
  let i = 0;
  while (s.length < size) s += `export function fn${f}_${i}(value: number, state: Record<string, unknown>) {\n  const render = value * ${i++}; // cache session tool group call message\n  return { render, state };\n}\n`;
  writeFileSync(join(cwd, "src", `file_${f}.ts`), s);
}
spawnSync("git", ["init", "-q"], { cwd });

const exts = mode === "rig"
  ? readdirSync(join(REPO, "extensions")).filter((d) => existsSync(join(REPO, "extensions", d, "index.ts")) && !exclude.includes(d)).map((d) => join(REPO, "extensions", d, "index.ts"))
  : [];
const env = {
  HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", LANG: "C.UTF-8", COLORTERM: "truecolor",
  PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
  ALLOC_OUT: OUT, ALLOC_PROMPTS: process.env.ALLOC_PROMPTS ?? "34", ALLOC_TPS: process.env.ALLOC_TPS ?? "400",
  ALLOC_INTERVAL: process.env.ALLOC_INTERVAL ?? "16384", ALLOC_PROFILE: rest.includes("--no-profile") ? "0" : "1", ALLOC_RETAINED: rest.includes("--retained") ? "1" : "0",
};
const piArgs = ["-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session", "--provider", "harness", "--model", "harness-1", "-e", join(HERE, "harness.ts")];
for (const e of exts) piArgs.push("-e", e);
if (mode !== "rig") piArgs.push("--tools", "read,bash,edit,write,grep");

const socket = `pi-alloc-${process.pid}`;
const tmux = (...a) => spawnSync("tmux", ["-u", "-L", socket, ...a], { encoding: "utf8" });
const node = [process.execPath, "--expose-gc", "--max-old-space-size=8192", "--import", join(HERE, "preload.mjs"), CLI];
tmux("new-session", "-d", "-x", "120", "-y", "40", "-c", cwd, "env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...node, ...piArgs);
tmux("set", "-g", "remain-on-exit", "on");
console.log(`${mode}: ${exts.length} rig extensions; box ${box}`);
const deadline = Date.now() + 40 * 60_000;
let lastScreen = "";
while (!existsSync(OUT + ".json")) {
  if (Date.now() > deadline) { console.log("TIMEOUT"); break; }
  const dead = tmux("display-message", "-p", "#{pane_dead}").stdout.trim();
  lastScreen = tmux("capture-pane", "-p").stdout;
  if (dead === "1") { console.log("pi exited early"); break; }
  await delay(1000);
}
console.log(lastScreen.split("\n").slice(-15).join("\n"));
tmux("kill-server");
rmSync(box, { recursive: true, force: true });
