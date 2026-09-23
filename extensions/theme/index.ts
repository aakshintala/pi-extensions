// /theme: Pi's own theme picker (the one /settings uses), opened directly.
//
// Pi's picker previews through its theme module, which swaps the active Theme
// in memory and never touches the theme setting, the theme file watcher or the
// light/dark auto-sync, so cancelling restores Pi's exact prior state. That
// module is not reachable from an extension: ctx.ui.setTheme() with a Theme
// instance marks the theme "<in-memory>", stops the watcher and turns
// auto-sync off. So preview and cancel swap the active Theme on the global slot
// Pi's theme module reads, and redraw. That write is guarded twice: only on Pi
// 0.87.x, where the slot was verified, and only when the slot holds a theme.
// Anywhere else /theme has no live preview: moving only moves the cursor and
// cancel changes nothing. Select goes through ctx.ui.setTheme(name), which Pi
// persists.
import { type ExtensionAPI, type Theme, ThemeSelectorComponent, VERSION } from "@earendil-works/pi-coding-agent";

// Pi 0.87 keeps the active Theme on these globals (modes/interactive/theme/theme.js).
const THEME_SLOTS = [Symbol.for("@earendil-works/pi-coding-agent:theme"), Symbol.for("@mariozechner/pi-coding-agent:theme")];
const slots = globalThis as unknown as Record<symbol, Theme | undefined>;

/** `piVersion` is Pi's own version; tests pass another to exercise the fallback. */
export default function (pi: ExtensionAPI, piVersion: string = VERSION) {
	pi.registerCommand("theme", {
		description: "Pick a theme with live preview",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/theme needs the interactive TUI", "error");
				return;
			}
			const name = ctx.ui.theme.name ?? "";
			const original = slots[THEME_SLOTS[0]!];
			const canPreview = /^0\.87\./.test(piVersion) && typeof original?.fg === "function";
			const chosen = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
				const show = (theme: Theme | undefined) => {
					if (!canPreview || !theme) return;
					for (const slot of THEME_SLOTS) slots[slot] = theme;
					tui.invalidate();
					tui.requestRender();
				};
				const picker = new ThemeSelectorComponent(
					name,
					(n) => done(n),
					() => {
						show(original); // nothing else changed, so this is Pi's prior state
						done(undefined);
					},
					(n) => show(ctx.ui.getTheme(n)),
				);
				return {
					render: (w: number) => picker.render(w),
					invalidate: () => picker.invalidate(),
					handleInput: (data: string) => picker.getSelectList().handleInput(data),
				};
			});
			if (chosen === undefined) return;
			const result = ctx.ui.setTheme(chosen);
			if (!result.success) ctx.ui.notify(`Theme ${chosen} failed to load: ${result.error}`, "error");
		},
	});
}
