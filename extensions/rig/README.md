# rig

The rig's settings menu (spec [#32](https://github.com/aakshintala/pi-rig/issues/32)). Every rig extension declares its settings in `rig.json` sections through `shared/settings`; this extension shows them all in one place.

## Command

`/rig` opens a tabbed menu with one tab per section that declares at least one setting. Each row shows the setting's current value; the selected row shows its description and default.

## Keys

| Key | Action |
|---|---|
| ←/→ | Switch tab |
| ↑/↓ | Select a setting |
| Click | Select a setting and change it, as Enter does (fullscreen only) |
| Enter/Space | Cycle a boolean or enum; type a new integer (only a valid value is saved) |
| e | Type a value for an open enum, such as a locale tag (only a valid value is saved) |
| r | Reset the selected setting to its default |
| Esc | Close the text editor, then the menu |

A change is saved to `~/.pi/agent/rig.json` at once (only non-default keys) and reaches the extension that owns it without a reload.

It also shows `rig.json` load warnings (bad values, unknown keys, invalid JSON) when a session starts.

## Settings

None of its own.
