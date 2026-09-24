import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => ctx.ui.setWidget("another", [" another widget"]));
  pi.registerCommand("other-widget", {
    description: "Redraw the test widget",
    handler: (_args, ctx) => ctx.ui.setWidget("another", [" another widget updated"]),
  });
}
