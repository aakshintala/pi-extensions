// /theme: Pi's own theme picker (the one /settings uses), opened directly.
// Preview and cancel change the theme in memory only; select goes through
// ctx.ui.setTheme(name), which Pi persists to settings.json itself.
import { type ExtensionAPI, ThemeSelectorComponent } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("theme", {
		description: "Pick a theme with live preview",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/theme needs the interactive TUI", "error");
				return;
			}
			// ctx.ui.theme is a live proxy, so keep a real instance to restore on cancel.
			const name = ctx.ui.theme.name ?? "";
			const original = ctx.ui.getTheme(name);
			const chosen = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
				const picker = new ThemeSelectorComponent(
					name,
					(n) => done(n),
					() => done(undefined),
					(n) => {
						const preview = ctx.ui.getTheme(n);
						if (preview) ctx.ui.setTheme(preview);
					},
				);
				return {
					render: (w: number) => picker.render(w),
					invalidate: () => picker.invalidate(),
					handleInput: (data: string) => picker.getSelectList().handleInput(data),
				};
			});
			if (chosen === undefined) {
				if (original) ctx.ui.setTheme(original);
				return;
			}
			const result = ctx.ui.setTheme(chosen);
			if (!result.success) ctx.ui.notify(`Theme ${chosen} failed to load: ${result.error}`, "error");
		},
	});
}
