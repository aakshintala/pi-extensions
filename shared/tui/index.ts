// Pi's main editor, found by structure: Pi exposes no handle to it.
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

/**
 * Whether Ctrl+B is free of Pi's default cursor-left binding, so it can background
 * commands (#29). Read it on each use: /reload re-reads keybindings.json after session_start.
 */
export const ctrlBFree = () => !getKeybindings().getKeys("tui.editor.cursorLeft").includes("ctrl+b");

type Node = { children?: unknown[]; getFocusedComponent?: () => unknown };

/**
 * Whether Pi's main editor has focus, so no picker, dialog or overlay owns the key.
 *
 * Pi 0.87.1 mounts its editor container as the root's fifth child
 * (interactive-mode.js:661, mountInteractiveTui) and wires its submit handler onto every
 * editor it mounts there; pickers and the reload box that take the slot have none. The
 * lookup is redone on each call so an editor swapped in by setEditorComponent is found.
 * Off Pi 0.87.x, or with anything else in the slot or in focus, it returns false: the
 * caller treats that as "cannot tell", never as a wrong component.
 */
export function editorFocused(tui: unknown, version: string = VERSION): boolean {
  if (!version.startsWith("0.87.")) return false;
  const root = tui as Node | undefined;
  const editor = (root?.children?.[4] as Node | undefined)?.children?.[0] as Record<string, unknown> | undefined;
  const isEditor = ["onSubmit", "getText", "handleInput"].every((k) => typeof editor?.[k] === "function");
  return isEditor && root!.getFocusedComponent?.() === editor;
}
