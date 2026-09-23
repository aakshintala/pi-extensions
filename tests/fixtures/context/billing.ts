// Test-only: stands in for a provider that reports partial usage on an
// aborted request, by adding usage to every assistant message. Load it before
// /context so /context sees the billed message.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		return { message: { ...message, usage: { ...message.usage, input: 500, cost: { ...message.usage.cost, total: 0.5 } } } };
	});
}
