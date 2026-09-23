// Test-only extension loaded by tests/helpers/tui.mjs into a real pi.
// - Registers provider "harness" / model "harness-1"; replies come from the JSON
//   array in $PI_HARNESS_REPLIES (each item: text, or an array of faux content blocks).
// - Appends one JSON line per lifecycle event to $PI_HARNESS_EVENTS so tests wait
//   on what pi reports instead of on time.
import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const EVENTS = ["session_start", "agent_start", "message_end", "tool_execution_end", "agent_end", "session_shutdown"] as const;

export default function (pi: ExtensionAPI) {
	const replies: any[] = JSON.parse(readFileSync(process.env.PI_HARNESS_REPLIES!, "utf8"));
	const core = createFauxCore({ provider: "harness", models: [{ id: "harness-1" }] });
	core.setResponses(
		replies.map((r) =>
			fauxAssistantMessage(r, { stopReason: Array.isArray(r) && r.some((b) => b.type === "toolCall") ? "toolUse" : "stop" }),
		),
	);
	// Faux estimates token usage from the whole context. The system prompt embeds
	// machine-specific paths, so drop it: the footer's token counts then depend only
	// on the scripted conversation and match on every machine.
	const noSystem = (stream: typeof core.stream): typeof core.stream => (model, context, options) =>
		stream(model, { ...context, messages: context.messages.filter((m: any) => m.role !== "system") }, options);
	pi.registerProvider(
		createProvider({
			id: core.provider,
			auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
			models: core.models,
			api: { stream: noSystem(core.stream), streamSimple: noSystem(core.streamSimple) },
		}),
	);

	for (const name of EVENTS) {
		pi.on(name, () => appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: name }) + "\n"));
	}
}
