// Allocation harness extension: registers faux provider "harness"/"harness-1" that streams
// scripted turns (thinking + text + tool calls) in small chunks, drives PROMPTS user
// prompts itself, and reports turns/chunks to globalThis.__alloc (preload.mjs).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

const PROMPTS = Number(process.env.ALLOC_PROMPTS ?? 34);
const FILES = Number(process.env.ALLOC_FILES ?? 40);

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const WORDS = "the a component render cache session tool group call message stream chunk frame width line text allocate heap buffer update invalidate diff result summary status footer queue todo fleet agent turn event handler state value key map list array string wrap split join theme style".split(" ");
const sentence = (n: number) => {
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(" ") + ".";
};
const prose = (chars: number) => {
  let s = "";
  while (s.length < chars) s += sentence(6 + Math.floor(rnd() * 12)) + (rnd() < 0.15 ? "\n\n" : " ");
  return s.trim();
};
const markdown = (chars: number) => {
  let s = "";
  while (s.length < chars) {
    const r = rnd();
    if (r < 0.15) s += `## ${sentence(4)}\n\n`;
    else if (r < 0.35) s += Array.from({ length: 4 }, () => `- **${pick(WORDS)}**: ${sentence(8)}`).join("\n") + "\n\n";
    else if (r < 0.5) s += "```ts\n" + Array.from({ length: 8 }, (_, i) => `const ${pick(WORDS)}${i} = ${pick(WORDS)}.${pick(WORDS)}(${i}); // ${sentence(3)}`).join("\n") + "\n```\n\n";
    else s += prose(400) + " `" + pick(WORDS) + "()` " + sentence(10) + "\n\n";
  }
  return s.trim();
};

const think = (chars: number) => ({ type: "thinking", thinking: prose(chars) });
const text = (chars: number) => ({ type: "text", text: markdown(chars) });
let ids = 0;
const call = (name: string, args: any) => ({ type: "toolCall", id: `call_${++ids}`, name, arguments: args });
const file = () => `src/file_${Math.floor(rnd() * FILES)}.ts`;
let marker = 0;

// One prompt's turns: calls in text-less turns join tool groups; the final turn is a long answer.
function promptTurns(p: number): ((tools: string[]) => any[])[] {
  return [
    () => [think(500), { type: "text", text: prose(150) }, call("read", { path: file() }), call("read", { path: file() })],
    (t) => [think(400), call(t.includes("grep") ? "grep" : "bash", t.includes("grep") ? { pattern: pick(WORDS), path: "src" } : { command: `grep -rn ${pick(WORDS)} src | head -100` }), call("bash", { command: `head -c ${2000 + Math.floor(rnd() * 18000)} ${file()}` })],
    () => { const m = marker++; return [think(300), call("edit", { path: `src/file_${m % FILES}.ts`, edits: [{ oldText: `// MARK_${m}\n`, newText: `// DONE_${m}\n${prose(120).replace(/^/gm, "// ")}\n` }] }), call("read", { path: file() })]; },
    (t) => t.includes("todo_write")
      ? [think(200), call("todo_write", { todos: [{ text: `step ${p}a`, status: "completed" }, { text: `step ${p}b`, status: "in_progress" }, { text: `step ${p}c`, status: "pending" }] })]
      : [think(200), call("bash", { command: "seq 1 400" })],
    () => [think(300), call("bash", { command: `wc -l src/*.ts | tail -5` }), call("read", { path: file() }), call("grep" , { pattern: "MARK_", path: "src" })],
    () => [think(800), text(2500 + Math.floor(rnd() * 2500))],
  ];
}

export default function (pi: ExtensionAPI) {
  const core = createFauxCore({ provider: "harness", models: [{ id: "harness-1", reasoning: true }], tokensPerSecond: Number(process.env.ALLOC_TPS ?? 400), tokenSize: { min: 2, max: 5 } });
  const steps: any[] = [];
  for (let p = 0; p < PROMPTS; p++)
    for (const turn of promptTurns(p))
      steps.push((ctx: any) => {
        const tools = (ctx.tools ?? []).map((t: any) => t.name);
        const blocks = turn(tools).map((b: any) => (b.type === "toolCall" && !tools.includes(b.name) ? call("bash", { command: "seq 1 50" }) : b));
        return fauxAssistantMessage(blocks, { stopReason: blocks.some((b: any) => b.type === "toolCall") ? "toolUse" : "stop" });
      });
  core.setResponses(steps);
  const noSystem = (stream: typeof core.stream): typeof core.stream => (model, context, options) =>
    stream(model, { ...context, messages: context.messages.filter((m: any) => m.role !== "system") }, options);
  pi.registerProvider(createProvider({
    id: core.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: { stream: noSystem(core.stream), streamSimple: noSystem(core.streamSimple) },
  }));

  const A = () => (globalThis as any).__alloc;
  let sent = 0;
  const next = () => {
    if (sent >= PROMPTS) return void A()?.finish();
    sent++;
    pi.sendUserMessage(`Prompt ${sent}: ${sentence(12)}`);
  };
  let started = false;
  pi.on("session_start", () => {
    if (started) return;
    started = true;
    setTimeout(async () => { await A()?.begin(); next(); }, 1500);
  });
  pi.on("message_update", (e: any) => {
    A()?.update();
    if (/_delta$/.test(e.assistantMessageEvent?.type ?? "")) A()?.chunk();
  });
  pi.on("turn_end", () => A()?.turn());
  pi.on("agent_end", () => setTimeout(next, 100));
}
