// Test-only tool for the grouping tests: `wait` blocks until the file named by its
// `file` argument exists in the working directory, so a test holds a group running
// until it creates the file. Rejects when the turn is aborted.
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolRenderers } from "../../../shared/tool-display/index.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "wait",
    label: "Wait",
    description: "Test tool.",
    parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } as never,
    ...toolRenderers({
      title: "Wait",
      arg: (a: any) => a.file ?? "",
      result: () => ({ summary: "Released", body: [] }),
      summary: { tool: "wait", verb: "waited on", one: "file" },
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
        const abort = () => done(new Error("aborted"));
        signal?.addEventListener("abort", abort);
        if (existsSync(path)) done();
      });
      return { content: [{ type: "text" as const, text: "released" }], details: undefined };
    },
  });
}
