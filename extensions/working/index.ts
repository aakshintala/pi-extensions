// Use Pi's existing editor indicator for model and tool activity; add no widget.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const FRAME_MS = 125;
type Phase = "Thinking" | "Running tool";

export function workingLabel(phase: Phase, elapsedMs: number, theme: Pick<Theme, "fg">): string {
  const at = Math.floor(elapsedMs / FRAME_MS) % phase.length;
  const glimmer = [...phase].map((c, i) => i === at ? theme.fg("accent", c) : c).join("");
  return `${glimmer} · ${Math.floor(elapsedMs / 1000)}s`;
}

export default function (pi: ExtensionAPI) {
  let started = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tools = new Set<string>();
  let ctx: ExtensionContext | undefined;

  const draw = () => {
    if (!ctx || !timer) return;
    ctx.ui.setWorkingMessage(workingLabel(tools.size ? "Running tool" : "Thinking", Date.now() - started, ctx.ui.theme));
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    tools.clear();
    ctx?.ui.setWorkingMessage();
    ctx = undefined;
  };

  pi.on("agent_start", (_event, c) => {
    if (c.mode !== "tui") return;
    stop();
    ctx = c;
    started = Date.now();
    timer = setInterval(draw, FRAME_MS);
    draw();
  });
  pi.on("tool_execution_start", (event) => {
    tools.add(event.toolCallId);
    draw();
  });
  pi.on("tool_execution_end", (event) => {
    tools.delete(event.toolCallId);
    draw();
  });
  pi.on("agent_end", stop);
  pi.on("session_shutdown", stop);
}
