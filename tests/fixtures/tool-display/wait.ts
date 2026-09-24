// Test-only tool for the grouping tests: `wait` blocks until the file named by its
// `file` argument exists in the working directory, so a test holds a group running
// until it creates the file. Rejects when the turn is aborted, with Pi's abort message.
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolRenderers } from "../../../shared/tool-display/index.ts";

export default function (pi: ExtensionAPI) {
  // A still working indicator, so a running screen differs only in the group's ⏺ line.
  pi.on("session_start", (_e, ctx) => ctx.ui.setWorkingIndicator({ frames: ["~"] }));
  pi.registerTool({
    name: "wait",
    label: "Wait",
    description: "Test tool.",
    parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } as never,
    ...toolRenderers({
      title: "Wait",
      arg: (a: any) => a.file ?? "",
      result: () => ({ summary: "Released", body: [] }),
      summary: { verb: "waited on", one: "file" },
    }),
    async execute(_id, params: { file: string }, signal, _onUpdate, ctx) {
      const path = join(ctx.cwd, params.file);
      await new Promise<void>((resolve, reject) => {
        const watcher = watch(ctx.cwd, () => existsSync(path) && done());
        const done = (error?: Error) => {
          watcher.close();
          signal?.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const abort = () => done(new Error("Operation aborted")); // as Pi's own tools
        signal?.addEventListener("abort", abort);
        if (signal?.aborted) abort();
        else if (existsSync(path)) done();
      });
      return { content: [{ type: "text" as const, text: "released" }], details: undefined };
    },
  });
}
