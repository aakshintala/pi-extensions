// todo_write and its widget (spec #28). The list lives in todo_write result details
// and is rebuilt from the active branch; nothing is written to disk.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { oneLine } from "../../shared/text/index.ts"; // item text is model input
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";

type Status = "pending" | "in_progress" | "completed";
type Todo = { text: string; status: Status };

const STATUSES: Status[] = ["pending", "in_progress", "completed"];
const MARK = { completed: "✔", in_progress: "◼", pending: "◻" };
const MAX_OPEN_ROWS = 7; // open items shown before "… N more"


export const widgetLines = (todos: Todo[]): string[] => {
  const done = todos.filter((t) => t.status === "completed").length;
  const open = todos.filter((t) => t.status !== "completed");
  const lines = done ? [`${MARK.completed} ${done} done`] : [];
  for (const t of open.slice(0, MAX_OPEN_ROWS)) lines.push(`${MARK[t.status]} ${oneLine(t.text)}`);
  if (open.length > MAX_OPEN_ROWS) lines.push(`… ${open.length - MAX_OPEN_ROWS} more`);
  return lines;
};

const isChild = (ctx: ExtensionContext) =>
  ctx.sessionManager.getEntries().some((e: any) => e.type === "custom" && e.customType === "rig.subagent");

const hasToolCall = (m: any) => Array.isArray(m?.content) && m.content.some((b: any) => b.type === "toolCall");

export default function (pi: ExtensionAPI) {
  let todos: Todo[] = [];
  let hidden = false; // a fully completed list, hidden once the next prompt is sent

  const allDone = () => todos.length > 0 && todos.every((t) => t.status === "completed");

  const draw = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || isChild(ctx)) return;
    const lines = widgetLines(todos);
    ctx.ui.setWidget(
      "todo",
      todos.length && !hidden
        ? () => ({ render: (width: number) => lines.map((l) => ` ${truncateToWidth(l, width - 2)}`), invalidate() {} })
        : undefined,
    );
  };

  const rebuild = (_event: unknown, ctx: ExtensionContext) => {
    todos = [];
    let promptedSince = false;
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type !== "message") continue;
      const m = e.message;
      if (m.role === "user") promptedSince = true;
      if (m.role === "toolResult" && m.toolName === "todo_write" && !m.isError && Array.isArray(m.details?.todos)) {
        todos = m.details.todos;
        promptedSince = false;
      }
    }
    hidden = allDone() && promptedSince;
    draw(ctx);
  };
  pi.on("session_start", rebuild);
  pi.on("session_tree", rebuild);

  pi.on("before_agent_start", (_event, ctx) => {
    if (allDone() && !hidden) {
      hidden = true;
      draw(ctx);
    }
  });

  // Reminder: on the first request of a prompt, when the previous turn (from the user
  // message that started it through its last reply; later queued prompts join it) made
  // no tool call while an item is in progress.
  // Added to this request only; the returned copy is never saved.
  pi.on("context", (event) => {
    const active = todos.filter((t) => t.status === "in_progress");
    const users = event.messages.flatMap((m: any, i) => (m.role === "user" ? [i] : []));
    const end = users.at(-1);
    if (!active.length || end !== event.messages.length - 1) return;
    const reply = event.messages.findLastIndex((m: any) => m.role === "assistant");
    const start = users.filter((i) => i < reply).at(-1);
    if (reply < 0 || start === undefined || event.messages.slice(start + 1, end).some(hasToolCall)) return;
    const text = `<system-reminder>Todo items still in progress: ${active.map((t) => JSON.stringify(t.text)).join(", ")}. Update your list with todo_write: mark finished items completed and stalled ones pending.</system-reminder>`;
    const messages = [...event.messages];
    const last: any = messages[end];
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    messages[end] = { ...last, content: [...content, { type: "text", text }] };
    return { messages };
  });

  pi.registerTool({
    name: "todo_write",
    label: "Todo",
    description:
      "Replace your whole todo list. Use it to plan and track multi-step work, sending the full list on every call.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full list, in order; it replaces the previous one. [] clears it.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The task, in a few words." },
              status: {
                type: "string",
                enum: STATUSES,
                description: "in_progress when you start the item; completed as soon as it is done.",
              },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["todos"],
    } as never,
    ...toolRenderers({
      title: "TodoWrite",
      arg: () => "",
      result: (r) => ({ summary: resultText(r), body: [] }),
      summary: { verb: "updated", many: "todos" },
    }),
    async execute(_id, params: { todos: Todo[] }, _signal, _onUpdate, ctx) {
      const next = params.todos.map(({ text, status }, i) => {
        if (typeof text !== "string" || !text.trim()) throw new Error(`todos[${i}].text is empty`);
        if (!STATUSES.includes(status)) throw new Error(`todos[${i}].status must be pending, in_progress or completed`);
        return { text: text.trim(), status };
      });
      todos = next;
      hidden = false;
      draw(ctx);
      const counts = STATUSES.map((s) => `${next.filter((t) => t.status === s).length} ${s}`).join(", ");
      return {
        content: [{ type: "text" as const, text: next.length ? `Todo list saved: ${counts}.` : `Todo list cleared: ${counts}.` }],
        details: { todos: next },
      };
    },
  });
}
