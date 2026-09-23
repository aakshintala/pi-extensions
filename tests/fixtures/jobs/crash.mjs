// Test-only: starts a background job, prints its group id and log path, then exits
// without session_shutdown, as Pi does after a crash. Run with the cwd, HOME and
// PI_CODING_AGENT_DIR set to a scratch directory.
import "../tool-display/pi-tui.mjs";
import { existsSync, readFileSync } from "node:fs";

const { default: jobs } = await import("../../../extensions/jobs/index.ts");
const tools = new Map();
jobs({ registerTool: (tool) => tools.set(tool.name, tool), on() {} });
const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "crash", getSessionFile: () => undefined } };
const r = await tools.get("bash").execute("c1", { command: "echo $$ > pgid; exec tail -f /dev/null", run_in_background: true }, undefined, undefined, ctx);
while (!existsSync("pgid") || !readFileSync("pgid", "utf8").endsWith("\n")) await new Promise((done) => setTimeout(done, 10));
console.log(readFileSync("pgid", "utf8").trim());
console.log(r.details.log);
process.exit(1);
