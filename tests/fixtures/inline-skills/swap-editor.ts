// `/swap` replaces Pi's editor with a new CustomEditor after the session started.
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("swap", {
    description: "Swap in a new editor",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorComponent((tui, theme, kb) => new CustomEditor(tui, theme, kb));
      ctx.ui.notify("swapped", "info");
    },
  });
}
