// Hidden thinking renders nothing (#57): guarded patch #2 of the three the rig allows (#1).
//
// Pi 0.87 draws a hidden thinking block as a "Thinking..." label plus spacing, and no
// public hook removes it. This wraps AssistantMessageComponent.prototype.updateContent:
// after Pi builds the message's children, hidden thinking (no per-block click override)
// loses its label and the spacer after it, so it renders zero lines and the group
// summary's "thought ·" stands in for it. Shown thinking gets a restyled label line.
// Only the screen changes: the message object is never touched.
//
// Guards: Pi 0.87.x only, and the children must match exactly what Pi 0.87 builds for
// the message; on any mismatch the render is left as Pi made it.
import { AssistantMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";

// Process-wide: installed once however many sessions (or reloaded copies of this
// module) use it, and restored when the last one releases it.
const MARK = Symbol.for("pi-rig.hidden-thinking");
const THEME = Symbol.for("@earendil-works/pi-coding-agent:theme"); // Pi 0.87's active theme
const LABEL = "✻ Thinking";

type Patch = { original: Function; owners: Set<object> };
const proto = AssistantMessageComponent.prototype as any;

const visible = (b: any) => (b?.type === "text" && b.text?.trim()) || (b?.type === "thinking" && b.thinking?.trim());

type Slot = { kind: "S" | "M" | "R" | "T"; drop?: boolean };

/** The children Pi 0.87's updateContent builds for `m`, marking the hidden-thinking ones. */
function expected(m: any): Slot[] {
  const c: any[] = m.content;
  const out: Slot[] = c.some(visible) ? [{ kind: "S" }] : [];
  for (let i = 0; i < c.length; i++) {
    if (c[i]?.type === "text" && c[i].text?.trim()) out.push({ kind: "M" });
    else if (c[i]?.type === "thinking") {
      let any = false;
      for (; i < c.length && c[i]?.type === "thinking"; i++) any ||= !!c[i].thinking?.trim();
      i--;
      if (!any) continue;
      out.push({ kind: "R", drop: true });
      if (c.slice(i + 1).some(visible)) out.push({ kind: "S", drop: true });
    }
  }
  const tools = c.some((b) => b?.type === "toolCall");
  if (m.stopReason === "length" || (!tools && (m.stopReason === "aborted" || m.stopReason === "error"))) out.push({ kind: "S" }, { kind: "T" });
  return out;
}

const kindOf = (x: unknown) =>
  x instanceof Spacer ? "S" : x instanceof Markdown ? "M" : x instanceof MouseRegion ? "R" : x instanceof Text ? "T" : "?";

function restyle(self: any, message: any) {
  const box = self.contentContainer;
  if (!box || !Array.isArray(message?.content) || self.thinkingVisibilityOverrides?.size) return;
  const want = expected(message);
  if (!want.some((s) => s.kind === "R")) return;
  const kids: any[] = box.children;
  const hidden = self.hideThinkingBlock === true;
  const inner = hidden ? Text : Markdown;
  const fits = kids.length === want.length &&
    want.every((s, i) => kindOf(kids[i]) === s.kind && (s.kind !== "R" || kids[i].child instanceof inner));
  if (!fits) return;
  if (!hidden) {
    const theme = (globalThis as any)[THEME];
    if (typeof theme?.fg !== "function") return;
    for (const r of kids.filter((k) => k instanceof MouseRegion)) {
      const labelled = new Container();
      labelled.addChild(new Text(theme.fg("accent", LABEL), self.outputPad ?? 1, 0));
      labelled.addChild(r.child);
      r.child = labelled;
    }
    return;
  }
  let keep = kids.filter((_, i) => !want[i]!.drop);
  // Without text, the leading spacer was only there for the thinking.
  if (!keep.some((k) => k instanceof Markdown)) keep = keep.slice(1);
  box.clear();
  for (const k of keep) box.addChild(k);
}

/** Installs the patch for `owner`; false when this Pi is not one it was verified on. */
export function useHiddenThinking(owner: object, piVersion: string = VERSION): boolean {
  if (!/^0\.87\./.test(piVersion) || typeof proto.updateContent !== "function") return false;
  let patch: Patch | undefined = proto[MARK];
  if (!patch) {
    const original = proto.updateContent;
    patch = { original, owners: new Set() };
    proto[MARK] = patch;
    proto.updateContent = function (message: any, ...rest: any[]) {
      const result = original.call(this, message, ...rest);
      try {
        restyle(this, message);
      } catch {
        // A shape this code does not know: keep Pi's render.
      }
      return result;
    };
  }
  patch.owners.add(owner);
  return true;
}

/** Releases `owner`'s use; the last release restores Pi's own updateContent. */
export function releaseHiddenThinking(owner: object): void {
  const patch: Patch | undefined = proto[MARK];
  if (!patch?.owners.delete(owner) || patch.owners.size) return;
  proto.updateContent = patch.original;
  delete proto[MARK];
}
