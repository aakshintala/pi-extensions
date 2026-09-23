// Replaces Pi's editor with a plain pi-tui Editor, so the inline-skills patch sees a shape mismatch.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    ctx.ui.setEditorComponent((tui, theme) => new Editor(tui, theme));
  });
}
