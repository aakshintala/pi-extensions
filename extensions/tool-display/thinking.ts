// Hidden thinking renders nothing (#57): guarded patch #2 of the three the rig allows (#1).
//
// Pi 0.87 draws a hidden thinking block as a "Thinking..." label plus spacing, and no
// public hook removes it. This wraps AssistantMessageComponent.prototype.updateContent:
// after Pi builds the message's children, each hidden thinking run (one the user has
// not clicked) loses its label and the spacer after it, so it renders zero lines and
// the group summary's "thought ·" stands in for it. Shown thinking gets a restyled
// label line. Only the screen changes: the message object is never touched.
//
// Guards: Pi 0.87.x only, and the children must match exactly what Pi 0.87 builds for
// the message; on any mismatch the render is left as Pi made it, and on a throw Pi's
// own children are rebuilt.
import { AssistantMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";

// Process-wide: installed once however many sessions (or reloaded copies of this
// module) use it, and restored when the last one releases it.
const MARK = Symbol.for("pi-rig.hidden-thinking");
const THEME = Symbol.for("@earendil-works/pi-coding-agent:theme"); // Pi 0.87's active theme
const LABEL = "✻ Thinking";

type Restyle = (self: any, message: any) => void;
type Patch = { original: Function; wrapper: Function; restyle: Restyle; owners: Set<object>; active: boolean };
const proto = AssistantMessageComponent.prototype as any;

const visible = (b: any) => (b?.type === "text" && b.text?.trim()) || (b?.type === "thinking" && b.thinking?.trim());

type Slot = { kind: "S" | "M" | "R" | "T"; trails?: boolean };

/** The children Pi 0.87's updateContent builds for `m`; `trails` marks a thinking run's spacer. */
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
      out.push({ kind: "R" });
      if (c.slice(i + 1).some(visible)) out.push({ kind: "S", trails: true });
    }
  }
  const tools = c.some((b) => b?.type === "toolCall");
  if (m.stopReason === "length" || (!tools && (m.stopReason === "aborted" || m.stopReason === "error"))) out.push({ kind: "S" }, { kind: "T" });
  return out;
}

const kindOf = (x: unknown) =>
  x instanceof Spacer ? "S" : x instanceof Markdown ? "M" : x instanceof MouseRegion ? "R" : x instanceof Text ? "T" : "?";

/**
 * Each thinking run is hidden (dropped with its spacer), shown (labelled), or clicked
 * open or closed by the user (left as Pi drew it), as Pi decides per run. Children are
 * checked and computed first, and swapped in last.
 */
function restyle(self: any, message: any) {
  const box = self.contentContainer;
  if (!box || !Array.isArray(message?.content)) return;
  const want = expected(message);
  const kids: any[] = box.children;
  if (kids.length !== want.length || !want.some((s) => s.kind === "R")) return;
  const overrides: Map<number, boolean> | undefined = self.thinkingVisibilityOverrides;
  const theme = (globalThis as any)[THEME];
  const drop = new Set<number>();
  const label: any[] = [];
  let run = 0;
  for (let i = 0; i < want.length; i++) {
    const s = want[i]!;
    if (kindOf(kids[i]) !== s.kind) return;
    if (s.kind !== "R") continue;
    const index = run++;
    const hidden = overrides?.get(index) ?? self.hideThinkingBlock === true;
    if (!(kids[i].child instanceof (hidden ? Text : Markdown))) return;
    if (overrides?.has(index)) continue;
    if (!hidden) label.push(kids[i]);
    else {
      drop.add(i);
      if (want[i + 1]?.trails) drop.add(i + 1);
    }
  }
  let keep = kids.filter((_, i) => !drop.has(i));
  // With nothing visible left, the leading spacer was only there for the thinking.
  if (!keep.some((k) => k instanceof Markdown || k instanceof MouseRegion)) keep = keep.slice(1);
  if (typeof theme?.fg === "function") {
    for (const r of label) {
      const labelled = new Container();
      labelled.addChild(new Text(theme.fg("accent", LABEL), self.outputPad ?? 1, 0));
      labelled.addChild(r.child);
      r.child = labelled;
    }
  }
  if (!drop.size) return;
  box.clear();
  for (const k of keep) box.addChild(k);
}

/** Installs the patch for `owner`; false when this Pi is not one it was verified on. */
export function useHiddenThinking(owner: object, piVersion: string = VERSION): boolean {
  if (!/^0\.87\./.test(piVersion) || typeof proto.updateContent !== "function") return false;
  let patch: Patch | undefined = proto[MARK];
  if (!patch) {
    const original = proto.updateContent;
    const wrapper = function (this: any, message: any, ...rest: any[]) {
      const result = original.call(this, message, ...rest);
      if (!p.active) return result;
      try {
        p.restyle(this, message);
      } catch {
        // A shape this code does not know: rebuild Pi's own children.
        return original.call(this, message, ...rest);
      }
      return result;
    };
    const p: Patch = { original, wrapper, restyle, owners: new Set(), active: true };
    patch = proto[MARK] = p;
    proto.updateContent = wrapper;
  }
  // A /reload loads this module again while another session still holds the patch:
  // the live wrapper runs the newest code.
  patch.restyle = restyle;
  patch.owners.add(owner);
  return true;
}

/**
 * Releases `owner`'s use. The last release restores Pi's own updateContent, unless
 * something wrapped it since: then the wrapper is left in place, inert.
 */
export function releaseHiddenThinking(owner: object): void {
  const patch: Patch | undefined = proto[MARK];
  if (!patch?.owners.delete(owner) || patch.owners.size) return;
  patch.active = false;
  delete proto[MARK];
  if (proto.updateContent === patch.wrapper) proto.updateContent = patch.original;
}
