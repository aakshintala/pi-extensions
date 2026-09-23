# theme

`/theme`: opens Pi's own theme picker, the one `/settings` uses. Spec:
[#36](https://github.com/aakshintala/pi-rig/issues/36).

- Moving through the list previews each theme in memory.
- Enter applies the theme; Pi saves it to `settings.json` itself.
- Esc restores the previous theme and saves nothing.
- Without the TUI, `/theme` says so.

## Tools and settings

None.

## Upstream

Replaces [`pi-theme-picker`](https://github.com/ldelossa/pi-theme-picker)
0.1.2 (MIT). No code was copied: the picker is Pi's exported
`ThemeSelectorComponent`, so there is no second picker and no write to
`settings.json` behind Pi's back.
