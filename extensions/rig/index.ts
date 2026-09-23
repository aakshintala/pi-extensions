// /rig: one tabbed settings menu over every declared rig.json section (spec #32).
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, matchesKey, SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { problem, rigSettings, type Section, type Setting, type Value } from "../../shared/settings/index.ts";

const parse = (s: Setting, text: string): Value =>
  s.type === "boolean" ? text === "true" : s.type === "integer" && /^-?\d+$/.test(text.trim()) ? Number(text) : text;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => rigSettings(getAgentDir()).notifyWarnings(ctx.ui));

  pi.registerCommand("rig", {
    description: "Rig settings",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return ctx.ui.notify("/rig needs the interactive UI", "error");
      const sections = rigSettings(getAgentDir()).sections().filter((s) => s.settings.length > 0);
      if (!sections.length) return ctx.ui.notify("No rig settings are declared", "info");
      const notify = (e: unknown) => ctx.ui.notify((e as Error).message, "error");
      await ctx.ui.custom<void>((tui, theme, _kb, done) => menu(sections, theme, notify, () => tui.requestRender(), done));
    },
  });
}

function menu(sections: Section[], theme: Theme, notify: (e: unknown) => void, render: () => void, close: () => void): Component {
  let tab = 0;
  let editing = false;
  const selected = sections.map(() => 0);
  const lists = sections.map((section) => {
    const item = (s: Setting): SettingItem => ({
      id: s.key,
      label: s.key,
      description: `${s.description}. Default: ${s.default}.`,
      currentValue: String(section.get(s.key)),
      ...(s.type === "integer"
        ? { submenu: (_current, done) => ((editing = true), integerEditor(s, theme, (v) => ((editing = false), done(v)))) }
        : { values: s.type === "boolean" ? ["true", "false"] : [...s.values] }),
    });
    const list: SettingsList = new SettingsList(
      section.settings.map(item),
      10,
      getSettingsListTheme(),
      (key, text) => {
        try {
          section.set(key, parse(section.settings.find((s) => s.key === key)!, text));
        } catch (e) {
          notify(e);
        }
        list.updateValue(key, String(section.get(key)));
      },
      close,
    );
    return list;
  });

  return {
    render(width) {
      const tabs = sections.map((s, i) => (i === tab ? theme.fg("accent", theme.bold(`[${s.name}]`)) : theme.fg("muted", ` ${s.name} `)));
      return [
        ` ${tabs.join(" ")}`,
        "",
        ...lists[tab].render(width),
        ...(editing ? [] : [theme.fg("dim", "  ←/→ to switch tab · r to reset to default")]),
      ];
    },
    invalidate: () => lists.forEach((l) => l.invalidate()),
    handleInput(data) {
      const kb = getKeybindings();
      const n = sections[tab].settings.length;
      if (editing) lists[tab].handleInput(data);
      else if (matchesKey(data, "left") || matchesKey(data, "right")) {
        tab = (tab + (matchesKey(data, "left") ? sections.length - 1 : 1)) % sections.length;
      } else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
        // Tracked here (and pushed with selectItem) so `r` knows the selected row.
        selected[tab] = (selected[tab] + (kb.matches(data, "tui.select.up") ? n - 1 : 1)) % n;
        lists[tab].selectItem(sections[tab].settings[selected[tab]].key);
      } else if (data === "r") {
        const key = sections[tab].settings[selected[tab]].key;
        try {
          sections[tab].reset(key);
        } catch (e) {
          notify(e);
        }
        lists[tab].updateValue(key, String(sections[tab].get(key)));
      } else lists[tab].handleInput(data);
      render();
    },
  };
}

// Text entry for an integer; only a valid value closes it with a result.
function integerEditor(s: Setting, theme: Theme, done: (value?: string) => void): Component {
  const input = new Input();
  input.focused = true;
  let error = "";
  input.onEscape = () => done();
  input.onSubmit = (text) => {
    const p = problem(s, parse(s, text));
    if (p) error = `${s.key} ${p}`;
    else done(String(parse(s, text)));
  };
  return {
    render: (width) => [
      theme.fg("accent", theme.bold(s.key)),
      theme.fg("muted", `${s.description}. Default: ${s.default}.`),
      "",
      ...input.render(width),
      ...(error ? [theme.fg("error", error)] : []),
      "",
      theme.fg("dim", "  Enter to save · Esc to go back"),
    ],
    invalidate: () => input.invalidate(),
    handleInput: (data) => input.handleInput(data),
  };
}
