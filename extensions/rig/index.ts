// /rig: one tabbed settings menu over every declared rig.json section (spec #32).
import { getAgentDir, getSettingsListTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, matchesKey, SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { problem, rigSettings, type Section, type Setting, type Value } from "../../shared/settings/index.ts";

const parse = (s: Setting, text: string): Value =>
  s.type === "boolean" ? text === "true" : s.type === "integer" && /^-?\d+$/.test(text.trim()) ? Number(text) : text.trim();

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
  // Open enums (`other`): the typed editor, when open, replaces the list.
  let typing: Component | undefined;
  const items = new Map<Setting, SettingItem>();
  // An open enum's cycle keeps its latest `other` value, so cycling never loses it.
  const cycle = (s: Setting & { type: "enum" }, value: string, item?: SettingItem) => {
    const extra = s.values.includes(value) ? item?.values?.slice(s.values.length) ?? [] : [value];
    return [...s.values, ...extra];
  };
  const lists = sections.map((section) => {
    const item = (s: Setting): SettingItem => {
      const it: SettingItem = {
        id: s.key,
        label: s.key,
        description: `${s.description}. Default: ${s.default}.`,
        currentValue: String(section.get(s.key)),
        ...(s.type === "integer"
          ? { submenu: (_current, done) => ((editing = true), textEditor(s, theme, (v) => ((editing = false), done(v)))) }
          : { values: s.type === "boolean" ? ["true", "false"] : cycle(s, String(section.get(s.key))) }),
      };
      items.set(s, it);
      return it;
    };
    const list: SettingsList = new SettingsList(
      section.settings.map(item),
      10,
      getSettingsListTheme(),
      (key, text) => apply(section, key, () => section.set(key, parse(section.settings.find((s) => s.key === key)!, text))),
      close,
    );
    return list;
  });
  // Runs a change, then shows the value the section now holds.
  function apply(section: Section, key: string, change: () => void) {
    try {
      change();
    } catch (e) {
      notify(e);
    }
    const s = section.settings.find((x) => x.key === key)!;
    const value = String(section.get(key));
    const it = items.get(s)!;
    if (s.type === "enum" && s.other) it.values = cycle(s, value, it);
    lists[sections.indexOf(section)].updateValue(key, value);
  }

  return {
    render(width) {
      const tabs = sections.map((s, i) => (i === tab ? theme.fg("accent", theme.bold(`[${s.name}]`)) : theme.fg("muted", ` ${s.name} `)));
      const current = sections[tab].settings[selected[tab]];
      const open = current?.type === "enum" && current.other;
      return [
        ` ${tabs.join(" ")}`,
        "",
        ...(typing ? typing.render(width) : lists[tab].render(width)),
        ...(editing || typing ? [] : [theme.fg("dim", `  ←/→ to switch tab · r to reset to default${open ? " · e to type a value" : ""}`)]),
      ];
    },
    invalidate: () => lists.forEach((l) => l.invalidate()),
    handleInput(data) {
      const kb = getKeybindings();
      const n = sections[tab].settings.length;
      const current = sections[tab].settings[selected[tab]];
      if (typing) typing.handleInput(data);
      else if (editing) lists[tab].handleInput(data);
      else if (data === "e" && current?.type === "enum" && current.other) {
        const section = sections[tab];
        typing = textEditor(current, theme, (v) => {
          typing = undefined;
          if (v !== undefined) apply(section, current.key, () => section.set(current.key, v));
          render();
        });
      }
      else if (matchesKey(data, "left") || matchesKey(data, "right")) {
        tab = (tab + (matchesKey(data, "left") ? sections.length - 1 : 1)) % sections.length;
      } else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
        // Tracked here (and pushed with selectItem) so `r` knows the selected row.
        selected[tab] = (selected[tab] + (kb.matches(data, "tui.select.up") ? n - 1 : 1)) % n;
        lists[tab].selectItem(sections[tab].settings[selected[tab]].key);
      } else if (data === "r") {
        const section = sections[tab];
        apply(section, current.key, () => section.reset(current.key));
      } else lists[tab].handleInput(data);
      render();
    },
  };
}

// Text entry for an integer or an open enum; only a valid value closes it with a result.
function textEditor(s: Setting, theme: Theme, done: (value?: string) => void): Component {
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
