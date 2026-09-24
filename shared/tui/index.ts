// Pi's main editor, found by structure: Pi exposes no handle to it.
import { CustomEditor, VERSION } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

/**
 * Whether Ctrl+B is free of Pi's default cursor-left binding, so it can background
 * commands (#29). Read it on each use: /reload re-reads keybindings.json after session_start.
 */
export const ctrlBFree = () => !getKeybindings().getKeys("tui.editor.cursorLeft").includes("ctrl+b");

type Node = { children?: unknown[]; getFocusedComponent?: () => unknown };

/**
 * Pi's main editor: the default editor, or one set by setEditorComponent. Pi gives
 * either its app actions and autocomplete a CustomEditor mounted by ui.custom() lacks.
 *
 * Pi 0.87.1 mounts it as the root's fifth child's only child (interactive-mode.js:661,
 * mountInteractiveTui). The lookup is redone on each call so a swapped-in editor is
 * found. Off Pi 0.87.x, or with anything else in the slot, undefined: the caller treats
 * that as "cannot tell", never as a wrong component.
 */
export function mainEditor(tui: unknown, version: string = VERSION): CustomEditor | undefined {
  if (!version.startsWith("0.87.")) return undefined;
  const editor = ((tui as Node | undefined)?.children?.[4] as Node | undefined)?.children?.[0] as
    | Record<string, unknown>
    | undefined;
  return editor instanceof CustomEditor &&
    typeof editor.tryTriggerAutocomplete === "function" &&
    typeof editor.isShowingAutocomplete === "function" &&
    Array.isArray((editor as { state?: { lines?: unknown } }).state?.lines) &&
    (editor as { actionHandlers?: Map<string, unknown> }).actionHandlers?.has?.("app.clear") === true
    ? editor
    : undefined;
}

/** Whether Pi's main editor has focus, so no picker, dialog or overlay owns the key. */
export function editorFocused(tui: unknown, version: string = VERSION): boolean {
  const editor = mainEditor(tui, version);
  return editor !== undefined && (tui as Node)?.getFocusedComponent?.() === editor;
}
