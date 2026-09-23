// Test-only: a Pi that dies with a background job running. Run with the cwd, HOME,
// PI_CODING_AGENT_DIR and TMPDIR set to a scratch directory.
//   crash.mjs        starts a job, prints its group id and log path, then exits without
//                    session_shutdown, as Pi does after a crash
//   crash.mjs kill   the same, but also prints this pid and dies by SIGKILL at once, so no
//                    exit handler runs; the job's crash record must already be written
//   crash.mjs reap   starts a session, which reaps what dead Pis left, and exits. A signal
//                    to pid 1 or to every process (-1) is printed instead of sent
import "../tool-display/pi-tui.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const mode = process.argv[2];
const { default: jobs } = await import("../../../extensions/jobs/index.ts");
const tools = new Map();
const handlers = new Map();
jobs({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
const until = async (ok) => {
  while (!ok()) await new Promise((done) => setTimeout(done, 10));
};

if (mode === "reap") {
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (signal && pid >= -1 && pid <= 1) return console.log(`refused kill(${pid}, ${signal})`), true;
    return kill(pid, signal);
  };
  await handlers.get("session_start")();
  process.exit(0);
}
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "crash", getSessionFile: () => undefined } };
const r = await tools.get("bash").execute("c1", { command: "echo $$ > pgid; exec tail -f /dev/null", run_in_background: true }, undefined, undefined, ctx);
await until(() => existsSync("pgid") && readFileSync("pgid", "utf8").endsWith("\n"));
console.log(readFileSync("pgid", "utf8").trim());
console.log(r.details.log);
if (mode === "kill") {
  console.log(process.pid);
  if (!existsSync(join(dirname(r.details.log), `${r.details.id}.pid`))) throw new Error("no crash record");
  process.kill(process.pid, "SIGKILL");
}
process.exit(1);
