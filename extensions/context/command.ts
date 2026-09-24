/**
 * `/context` command grammar, argument completions, and Initial capture
 * resolution shared by the Usage and Injections views.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildNativeSnapshot, type InitialCaptureState, type SilentProbeState } from "./capture.ts";
import type { InitialSnapshot } from "./model.ts";
import { runWithProbeToken } from "./probe-token.ts";
import { normalizePreviewText } from "./text.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections]";
/**
 * Slash-command palette text, kept beside the grammar it describes.
 * RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
 */
export const CONTEXT_COMMAND_DESCRIPTION =
	"[usage|injections] - Inspect context usage, injections";
/** Cap for reported messages, which may quote OS error text. */
const MAX_REPORTED_MESSAGE_LENGTH = 500;
const DEFAULT_VIEW: ContextView = "usage";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore initial context injections" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "invalid"; readonly message: string };

/** Resolved Initial capture, possibly degraded to the pi-native fallback. */
interface InitialCaptureResult {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { type: "view", view: DEFAULT_VIEW };
	}
	if (words.length === 1 && words[0] === "usage") {
		return { type: "view", view: "usage" };
	}
	if (words.length === 1 && words[0] === "injections") {
		return { type: "view", view: "injections" };
	}
	return { type: "invalid", message: COMMAND_USAGE };
}

/** Complete full argument values for the supported `/context` grammar. */
export function getContextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
	const matches = ARGUMENT_OPTIONS.filter((option) => option.value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((option) => ({ ...option })) : null;
}

/** Obtain Initial through passive capture, one silent probe, or a pi-native fallback. */
export async function resolveInitialCapture(
	pi: ExtensionAPI,
	capture: InitialCaptureState,
	probe: SilentProbeState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	// Pi's idle wait also covers compaction, so no compaction can reject the probe after it.
	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	const unavailableReason = await getProbeUnavailableReason(context);
	if (unavailableReason !== undefined) {
		return createFallback(pi, context, unavailableReason);
	}

	const attempt = probe.start();
	if (attempt.started) {
		context.ui.setWorkingVisible(false);
		try {
			// Pi emits `input` and `before_agent_start` from inside this call, so the
			// token reaches both handlers and identifies the run even when another
			// extension's input transform rewrites the prompt text.
			runWithProbeToken(attempt.token, () => pi.sendUserMessage(""));
		} catch (error) {
			probe.fail(error instanceof Error ? error.message : String(error));
		}
	}

	try {
		const outcome = await attempt.completion;
		if (outcome.status === "captured" && capture.snapshot !== undefined) {
			return { snapshot: capture.snapshot };
		}
		const reason = outcome.status === "failed" ? outcome.reason : "Silent probe did not capture Initial.";
		return createFallback(pi, context, reason);
	} finally {
		if (attempt.started) context.ui.setWorkingVisible(true);
	}
}

/**
 * Report command errors in both interactive and headless modes. Messages can
 * quote untrusted text such as OS errors, so they are sanitized and capped
 * before reaching the terminal.
 */
export function reportCommandMessage(
	context: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	const safeMessage = truncate(normalizePreviewText(message), MAX_REPORTED_MESSAGE_LENGTH);
	if (context.hasUI) {
		context.ui.notify(safeMessage, type);
		return;
	}
	process.stderr.write(`${safeMessage}\n`);
}

/** Refuse a view outside TUI mode, naming the form the user typed. */
export function reportTuiOnly(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(context, `/context ${view} is available in TUI mode only.`, "warning");
}

/** Shorten over-long text with an ellipsis marker. */
function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Explain why a silent probe cannot run now, or undefined when it can. Auth is
 * checked the way Pi checks it before a prompt: configured, or resolvable now.
 */
async function getProbeUnavailableReason(context: ExtensionCommandContext): Promise<string | undefined> {
	const model = context.model;
	if (model === undefined) return "Silent probe unavailable: no model is selected.";
	if (!context.modelRegistry.hasConfiguredAuth(model) && !(await context.modelRegistry.getApiKeyAndHeaders(model)).ok) {
		return `Silent probe unavailable: ${model.provider} has no configured authentication.`;
	}
	return undefined;
}

/** Build a degraded pi-native snapshot when passive capture and probing both failed. */
function createFallback(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	reason: string,
): InitialCaptureResult {
	return {
		snapshot: buildNativeSnapshot({
			systemPrompt: context.getSystemPrompt(),
			options: context.getSystemPromptOptions(),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		degradedReason: `${reason} Extension additions were not observed.`,
	};
}
