// Test-only tool "gate": reports gate_waiting on the harness events file, then blocks
// until the test creates `release-<n>` in the cwd (n counts calls) or the run is aborted, so input can be
// typed while the agent works. The working indicator is made static so mid-run
// screens are stable.
import { appendFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let calls = 0;
	pi.on("session_start", (_e, ctx) => ctx.ui.setWorkingIndicator({ frames: ["●"] }));
	pi.registerTool({
		name: "gate",
		label: "Gate",
		description: "Waits for the test.",
		parameters: { type: "object", properties: {} } as never,
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const file = join(ctx.cwd, `release-${++calls}`);
			const watcher = watch(ctx.cwd);
			const released = new Promise<void>((done) => {
				const check = () => existsSync(file) && (watcher.close(), done());
				watcher.on("change", check);
				signal?.addEventListener("abort", () => (watcher.close(), done()));
				check();
			});
			appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: "gate_waiting" }) + "\n");
			await released;
			return { content: [{ type: "text" as const, text: "released" }], details: {} };
		},
	});
}
