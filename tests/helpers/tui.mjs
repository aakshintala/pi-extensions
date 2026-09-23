// Real interactive `pi` in a private tmux server, driven by keys, synchronised on
// events pi reports (ADR 0001: no sleeps, full-screen asserts, one server per test).
//
//   const tui = await startTui(t, { replies, extensions, args, cols, rows });
//   tui.type("hello"); tui.keys("Enter");      // literal text / tmux key names
//   tui.click(col, row);                       // SGR left click, 1-based cell
//   await tui.waitForEvent("agent_end");        // nth occurrence: waitForEvent(name, n)
//   await tui.waitForScreen(`\n...`);          // whole screen, rows trimmed right;
//                                              // one leading newline is dropped
//   tui.screen(); tui.events(); tui.home; tui.cwd
//
//   replies     JSON items for the faux model "harness/harness-1": text, or an array of
//               faux content blocks ({type:"toolCall", id, name, arguments} etc.)
//   extensions  extra extension paths (discovery is off; tests/helpers/tui-extension.ts
//               is always loaded and reports events: see its EVENTS)
//
// Hermetic: temp HOME + agent dir, offline, no credentials. startTui resolves once
// session_start is reported, when pi accepts input. The tmux server and temp dir are
// removed in t.after, so cleanup runs on failure too.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert";

const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
const EXTENSION = fileURLToPath(new URL("./tui-extension.ts", import.meta.url));
const TIMEOUT_MS = 20_000;

export async function startTui(t, { replies = [], extensions = [], args = [], cols = 80, rows = 24 } = {}) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-tui-")));
  const socket = `pi-rig-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmux = (...a) => {
    const r = spawnSync("tmux", ["-u", "-L", socket, ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tmux ${a[0]} failed: ${r.stderr}`);
    return r.stdout;
  };
  let socketPath;
  t.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    if (socketPath) rmSync(socketPath, { force: true }); // kill-server can leave the socket file
    rmSync(box, { recursive: true, force: true });
  });

  const home = join(box, "home");
  const cwd = join(home, "cwd");
  const agentDir = join(box, "agent");
  const events = join(box, "events.jsonl");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  // ponytail: stub fd/rg so startup never warns about missing tools; point these at real
  // binaries when a test needs @-file autocomplete or grep.
  for (const bin of ["fd", "rg"]) {
    writeFileSync(join(agentDir, "bin", bin), "#!/bin/sh\nexit 0\n");
    chmodSync(join(agentDir, "bin", bin), 0o755);
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
  writeFileSync(join(box, "replies.json"), JSON.stringify(replies));
  writeFileSync(events, "");
  writeFileSync(join(box, "tmux.conf"), "set -g extended-keys on\nset -g remain-on-exit on\nset -gq extended-keys-format csi-u\n");

  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_HARNESS_REPLIES: join(box, "replies.json"),
    PI_HARNESS_EVENTS: events,
  };
  const piArgs = ["-ne", "-ns", "-np", "-nc", "--no-themes", "--no-session", "--provider", "harness", "--model", "harness-1"];
  for (const e of [EXTENSION, ...extensions]) piArgs.push("-e", e);
  tmux("-f", join(box, "tmux.conf"), "new-session", "-d", "-x", String(cols), "-y", String(rows), "-c", cwd,
    "env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, PI_CLI, ...piArgs, ...args);
  socketPath = tmux("display-message", "-p", "#{socket_path}").trim();

  const readEvents = () => readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
  const screen = () =>
    tmux("capture-pane", "-p").split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
  const until = async (ok, describe) => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`);
      await delay(10); // poll interval, not a sync point: we wait on the condition
    }
  };

  const tui = {
    home,
    cwd,
    screen,
    events: readEvents,
    type: (text) => void tmux("send-keys", "-l", text),
    keys: (...keys) => void tmux("send-keys", ...keys),
    click: (col, row) => void tmux("send-keys", "-l", `\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`),
    waitForEvent: (name, n = 1) =>
      until(
        () => readEvents().filter((e) => e === name).length >= n,
        () => `event ${name} x${n}; got [${readEvents()}]\n${screen()}`,
      ),
    async waitForScreen(expected) {
      const want = expected.replace(/^\n/, "").split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
      try {
        await until(() => screen() === want, () => "screen");
      } catch {
        assert.equal(screen(), want);
      }
    },
  };
  await tui.waitForEvent("session_start");
  return tui;
}
