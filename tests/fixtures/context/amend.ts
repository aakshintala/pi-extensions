// Test-only: appends one clause to Pi's own leading system message in every
// request through `context_with_system`, instead of adding a message.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context_with_system", (event) => {
		const [head, ...rest] = event.messages;
		if (head?.role !== "system" || !head.sections?.rules) return undefined;
		const amended = { ...head, sections: { ...head.sections, rules: `${head.sections.rules}\n- Say thanks.` } };
		return { messages: [amended, ...rest] };
	});
}
