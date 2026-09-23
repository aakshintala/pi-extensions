// Test-only: replaces the machine-specific parts of pi's system prompt (the
// working directory and the install paths in the docs section), so /context
// shows the same token counts on every machine. Load it before /context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.cwd = "/work";
		(event.systemPromptOptions.sections ??= {}).docs = "Pi documentation is installed with pi.";
	});
}
