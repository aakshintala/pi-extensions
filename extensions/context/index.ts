/**
 * /context: inspect what occupies the model context, as a usage map or the
 * injections inspector. Ported from pi-context-view 0.6.0 (MIT, see README).
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn.
 */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportTuiOnly,
	resolveInitialCapture,
} from "./command.ts";
import {
	buildUsageSnapshot,
	InitialCaptureState,
	parsePersistedIdentities,
	PROBE_IDENTITIES_CUSTOM_TYPE,
	SilentProbeState,
} from "./capture.ts";
import { readProbeToken } from "./probe-token.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage } from "./composition.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	let persistedIdentityCount = 0;

	/** Persist identities (role and timestamp only, never content) not yet written; restore unions every entry. */
	function persistProbeIdentities(): void {
		const fresh = probe.syntheticMessages.slice(persistedIdentityCount);
		if (fresh.length === 0) return;
		pi.appendEntry(PROBE_IDENTITIES_CUSTOM_TYPE, { messages: fresh });
		persistedIdentityCount += fresh.length;
	}

	pi.on("session_start", (_event, ctx) => {
		// Rehydrate probe identities from all prior runtimes so persisted probe
		// messages stay out of later model contexts and Usage after resume,
		// reload, or fork. Restored identities are already persisted.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE) {
				probe.restoreIdentities(parsePersistedIdentities(entry.data));
			}
		}
		persistedIdentityCount = probe.syntheticMessages.length;
	});

	pi.on("input", (event) => {
		// Reset text earlier input transforms added to our own synthetic prompt:
		// the probe carries no instructions, and its run is identified by token.
		if (event.text === "" || !probe.isProbeInput(event.source, readProbeToken())) return undefined;
		return { action: "transform", text: "" } as const;
	});

	pi.on("before_agent_start", (event) => {
		probe.beginRun(readProbeToken());
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("turn_start", (_event, ctx) => {
		// Only a turn carrying the probe token is the probe's; a user turn is never aborted.
		if (probe.shouldAbortTurn(readProbeToken())) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message, readProbeToken());
	});

	pi.on("message_end", (event) => {
		const message = probe.sanitizeMessage(event.message, readProbeToken());
		return message === undefined ? undefined : { message };
	});

	// Keep probe messages out of every model request.
	pi.on("context", (event) => {
		const messages = probe.filterMessages(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	// Pi 0.87 sends system messages (the prompt and its patches) only to this event,
	// so the snapshot is frozen here to include system-prompt additions.
	pi.on("context_with_system", (event, ctx) => {
		// Lazy: this event fires once per LLM request, but only the freezing call
		// reads these inputs, and the baseline rebuild alone is O(session).
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages: probe.filterMessages(event.messages),
			baselineMessages: probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		}));
		return undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle(capture.snapshot !== undefined);
		persistProbeIdentities();
	});

	pi.on("session_shutdown", () => {
		// A shutdown mid-probe can leave probe messages already persisted in the
		// session; write their identities so the next runtime keeps filtering them.
		persistProbeIdentities();
		probe.fail("Session ended before the silent probe completed.");
	});

	pi.registerCommand("context", {
		description: CONTEXT_COMMAND_DESCRIPTION,
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			if (ctx.mode !== "tui") {
				reportTuiOnly(ctx, command.view);
				return;
			}
			const initial = await resolveInitialCapture(pi, capture, probe, ctx);
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
			const messages = probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			const current = buildUsageSnapshot({
				messages,
				initial: initial.snapshot,
				systemPrompt: ctx.getSystemPrompt(),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});
			await showUsageView(ctx, {
				usage: computeUsage({
					snapshot: current,
					initial: initial.snapshot,
					messages,
					reported: ctx.getContextUsage(),
					modelLabel: ctx.model?.id,
					autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
				}),
				degradedReason: initial.degradedReason,
			});
		},
	});
}
