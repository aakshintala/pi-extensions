// ask_user: questions in a bottom panel with inline free text (spec #34).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { oneLine } from "../../shared/text/index.ts"; // question text is model input
import { panel, type Outcome, type Question } from "./panel.ts";

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });

const PARAMETERS = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "Asked together, one tab each",
      items: {
        type: "object",
        required: ["question", "header"],
        additionalProperties: false,
        properties: {
          question: str("The full question with its context"),
          header: { ...str("Tab label"), maxLength: 12 },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "Omit for a free-text question",
            items: {
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: { label: str("Short choice"), description: str("One line") },
            },
          },
          multiSelect: { type: "boolean", description: "Allow several choices" },
        },
      },
    },
  },
};

const DESCRIPTION =
  "Ask the user 1-4 questions in a panel. Use it instead of listing choices in chat whenever you need a decision, preference or confirmation. " +
  "Every question also takes a typed answer or a skip. Put a recommended option first and end its label with (Recommended). " +
  'Returns a line per question: `header: labels`, `header: "typed"` or `header: skipped`, then `note: ...` if given; `cancelled` if declined.';

const clean = (q: Question): Question => ({
  ...q,
  question: oneLine(q.question),
  header: oneLine(q.header),
  options: q.options?.map((o) => ({ label: oneLine(o.label), ...(o.description ? { description: oneLine(o.description) } : {}) })),
});

/** One compact line per question, then the note; `cancelled` alone when declined. */
export function format(questions: Question[], o: Outcome): string {
  if (o.cancelled) return "cancelled";
  const lines = questions.map((q, i) => {
    const a = o.answers[i];
    const parts = a ? [...a.labels, ...(a.text ? [`"${a.text}"`] : [])] : ["skipped"];
    return `${q.header}: ${parts.join(", ")}`;
  });
  if (o.note) lines.push(`note: ${o.note}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Subagents never open a panel: #26 writes `rig.subagent` as a child session's first entry.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === "rig.subagent")) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user"));
    }
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: DESCRIPTION,
    parameters: PARAMETERS as never,
    executionMode: "sequential",
    async execute(_id, params: { questions: Question[] }, signal, _onUpdate, ctx) {
      const questions = params.questions.map(clean);
      for (const q of questions) {
        if (visibleWidth(q.header) > 12) throw new Error(`header "${q.header}" is wider than 12 columns`);
      }
      if (ctx.mode !== "tui") throw new Error("No interactive user here. State your assumption and continue.");
      const outcome: Outcome = signal?.aborted
        ? { cancelled: true }
        : await ctx.ui.custom<Outcome>((tui, theme, _kb, done) => {
            // An aborted turn closes the panel; the call then reports `cancelled`.
            signal?.addEventListener("abort", () => done({ cancelled: true }), { once: true });
            return panel(questions, theme, () => tui.requestRender(), done);
          });
      return { content: [{ type: "text", text: format(questions, outcome) }], details: { questions, ...outcome } };
    },
  });
}
