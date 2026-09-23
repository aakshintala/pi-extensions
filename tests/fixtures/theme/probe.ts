// Test-only: a widget that shows the active theme's name, so the plain-text
// screen reveals previews (the theme proxy re-reads on every render).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		ctx.ui.setWidget("theme-probe", (_tui, theme) => ({
			render: () => [`theme: ${theme.name}`],
			invalidate() {},
		}));
	});
}
