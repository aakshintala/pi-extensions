/**
 * Terminal sanitizer for multi-line preview text; one-line text uses shared
 * `oneLine`. Every string that reaches the terminal from outside this
 * extension passes through one of them first.
 */
import { stripSequences } from "../../shared/text/index.ts";

/** Normalize line breaks and tabs, then remove terminal sequences and control characters but keep lines. */
export function normalizePreviewText(text: string): string {
	return stripSequences(text.replace(/\r\n?/g, "\n").replaceAll("\t", "    "))
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}
