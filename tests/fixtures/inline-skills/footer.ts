// A fixed footer: Pi's own shows token counts, which vary with the fixture skills' absolute paths.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    ctx.ui.setFooter(() => ({ render: () => ["(footer)"], invalidate() {} }));
  });
}
