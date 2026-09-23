// Test-only: injects one system message into every request through
// `context_with_system`, the way an extension patches the prompt on Pi 0.87.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, { role: "system", content: "Injected reminder.", timestamp: 0 }],
	}));
}
