// Test-only: the scripted model "kid/kid-1" for subagent tests, loaded into the parent
// (so the model validates) and into every child through the agent dir's settings.json.
//
// In-process tests set globalThis[Symbol.for("pi-rig.test.kid")](context, options) to
// answer every child request; it may return a promise, to hold a child mid-run.
// Otherwise (a real pi) replies come in order from <agent dir>/kid.json, each
// `{ content, after? }`: faux content (text or blocks), sent once the file `after`
// (relative to the agent dir) exists. kid.json is that list, or an object of such lists
// keyed by the child's task (its spawn prompt), each read in its own order. File mode
// also stops the fleet clock at 0, and a child session reports event "child_start" to
// $PI_HARNESS_EVENTS (tests/helpers/tui.mjs); the first child to start first writes its
// agent id to <agent dir>/child-id.
//
// In a parent (no rig.subagent entry), globalThis[Symbol.for("pi-rig.test.parentPrompt")],
// when set, is merged into before_agent_start's systemPromptOptions; this fixture loads
// ahead of the subagents extension, which reads them.
// Command /kidcmd exists so a test can send its name as plain text.
// Each session_shutdown pushes the session id to globalThis[Symbol.for("pi-rig.test.kidShutdown")].
// Tool `start_job` registers a fleet item owned by its session; the item's stop() calls
// globalThis[Symbol.for("pi-rig.test.jobStopped")](id) and leaves it running.
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fleet } from "../../../shared/fleet/index.ts";

const g = globalThis as any;
const STEP = Symbol.for("pi-rig.test.kidStep");

function exists(path: string) {
  return new Promise<void>((resolve) => {
    const watcher = watch(join(path, ".."), () => existsSync(path) && done());
    const done = () => {
      watcher.close();
      resolve();
    };
    if (existsSync(path)) done();
  });
}

async function fromFile(context: any) {
  const all = JSON.parse(readFileSync(join(getAgentDir(), "kid.json"), "utf8"));
  const first = context.messages.find((m: any) => m.role === "user");
  const text = typeof first.content === "string" ? first.content : first.content.map((c: any) => c.text ?? "").join("");
  const task = Array.isArray(all) ? "" : text.split("\n\nEnd your final message")[0];
  const counts = (g[STEP] ??= {});
  const step = (Array.isArray(all) ? all : all[task])[(counts[task] = (counts[task] ?? -1) + 1)];
  if (step.after) await exists(join(getAgentDir(), step.after));
  const tools = Array.isArray(step.content) && step.content.some((b: any) => b.type === "toolCall");
  return fauxAssistantMessage(step.content, { stopReason: tools ? "toolUse" : "stop" });
}

export default function (pi: ExtensionAPI) {
  if (!g[Symbol.for("pi-rig.test.kid")]) {
    fleet().now = () => 0;
    pi.on("session_start", (_event, ctx) => {
      const marker: any = ctx.sessionManager.getEntries().find((e: any) => e.customType === "rig.subagent");
      if (!marker) return;
      if (!existsSync(join(getAgentDir(), "child-id"))) writeFileSync(join(getAgentDir(), "child-id"), marker.data.agentId);
      appendFileSync(process.env.PI_HARNESS_EVENTS!, JSON.stringify({ event: "child_start" }) + "\n");
    });
  }
  const core = createFauxCore({ provider: "kid", models: [{ id: "kid-1", reasoning: true }] });
  const next = (stream: typeof core.stream): typeof core.stream => (model, context, options) => {
    core.setResponses([(ctx, opts) => (g[Symbol.for("pi-rig.test.kid")] ?? fromFile)(ctx, opts)]);
    return stream(model, context, options);
  };
  pi.registerProvider(
    createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Kid", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream: next(core.stream), streamSimple: next(core.streamSimple) },
    }),
  );

  pi.on("before_agent_start", (event, ctx) => {
    const extra = g[Symbol.for("pi-rig.test.parentPrompt")];
    if (extra && !ctx.sessionManager.getEntries().some((e: any) => e.customType === "rig.subagent")) Object.assign(event.systemPromptOptions, extra);
  });
  pi.registerCommand("kidcmd", { description: "test", handler: async () => {} });

  pi.on("session_shutdown", (_event, ctx) => g[Symbol.for("pi-rig.test.kidShutdown")]?.push(ctx.sessionManager.getSessionId()));

  pi.registerTool({
    name: "start_job",
    label: "job",
    description: "test",
    parameters: { type: "object", properties: { id: { type: "string" } } } as any,
    async execute(_callId, params: any, _signal, _update, ctx) {
      fleet().register({
        id: params.id,
        owner: ctx.sessionManager.getSessionId(),
        kind: "shell",
        label: params.id,
        activity: () => "",
        view: { log: "/dev/null" },
        stop: () => g[Symbol.for("pi-rig.test.jobStopped")]?.(params.id),
      });
      return { content: [{ type: "text", text: "started" }], details: undefined };
    },
  });
}
