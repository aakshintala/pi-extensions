// Rig settings: one `rig.json` in Pi's agent directory, one section per
// extension. Extensions declare their settings; the file is validated
// against the declarations and written back with only non-default keys.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Value = boolean | number | string;

export type Setting = { key: string; description: string } & (
  | { type: "boolean"; default: boolean }
  | { type: "integer"; default: number; min?: number; max?: number }
  | {
      type: "enum";
      default: string;
      values: readonly string[];
      /** Makes the enum open: strings passing `test` are valid too, e.g. `{ label: "an IANA zone", test: isZone }`. */
      other?: { label: string; test(value: string): boolean };
    }
);

export interface Section {
  readonly name: string;
  readonly settings: readonly Setting[];
  get(key: string): Value;
  values(): Record<string, Value>;
  /** Validates, merges into the current file and writes it atomically. Throws on an invalid value or unreadable file. */
  set(key: string, value: Value): void;
  /** `set` for several keys in one write; all are validated before anything is written. */
  setMany(values: Record<string, Value>): void;
  reset(key: string): void;
  /** Hears every change, including a redeclare's added keys and removed ones (value `undefined`). */
  onChange(listener: (key: string, value: Value | undefined) => void): () => void;
}

export interface RigSettings {
  readonly path: string;
  /** Declares a section, reading its values from the file. A redeclare returns the same handle with the new settings, keeping its listeners. */
  declare(name: string, settings: readonly Setting[]): Section;
  sections(): Section[];
  /** Sends each pending warning once, e.g. `rig.notifyWarnings(ctx.ui)`. */
  notifyWarnings(ui: { notify(message: string, type: "warning"): void }): void;
}

/** Why `value` is invalid for `setting`, or undefined when it is valid. */
export function problem(setting: Setting, value: unknown): string | undefined {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "integer": {
      const { min, max } = setting;
      if (!Number.isInteger(value)) return "must be an integer";
      if ((min === undefined || (value as number) >= min) && (max === undefined || (value as number) <= max)) return undefined;
      if (max === undefined) return `must be at least ${min}`;
      if (min === undefined) return `must be at most ${max}`;
      return `must be between ${min} and ${max}`;
    }
    case "enum": {
      const { values, other } = setting;
      if (values.includes(value as string) || (other && typeof value === "string" && other.test(value))) return undefined;
      return `must be one of ${values.join(", ")}${other ? ` or ${other.label}` : ""}`;
    }
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
// Own properties only, so a name like "__proto__" is an ordinary key.
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const put = (o: Record<string, unknown>, k: string, v: unknown) =>
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

export function createRigSettings(agentDir: string): RigSettings {
  const path = join(agentDir, "rig.json");
  const pending = new Set<string>();
  const warned = new Map<string, Set<string>>();

  // Throws on unparsable JSON; a missing or empty file is {}.
  function read(): Record<string, unknown> {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    if (!text.trim()) return {};
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
    }
    if (!isObject(json)) throw new Error(`${path} must contain a JSON object`);
    return json;
  }

  // One live section per name for the process: every handle `declare` returns
  // is the same object, so a child session's redeclare cannot retire the parent's.
  type Live = { section: Section; byKey: Map<string, Setting>; values: Map<string, Value>; listeners: Set<(key: string, value: Value | undefined) => void> };
  const sections = new Map<string, Live>();

  function declare(name: string, settings: readonly Setting[]): Section {
    const byKey = new Map(settings.map((s) => [s.key, s]));
    for (const s of settings) {
      const p = problem(s, s.default);
      if (p) throw new Error(`rig setting ${name}.${s.key}: default ${p}`);
    }

    const live = sections.get(name);
    // Each warning with the value behind it; queued only if this section's last declare did not already warn it.
    const found = new Map<string, string>();
    const warn = (message: string, value?: unknown, id = message) => found.set(`${id}\0${JSON.stringify(value)}`, message);
    const values = new Map<string, Value>(settings.map((s) => [s.key, s.default]));
    let raw: unknown;
    try {
      raw = own(read(), name);
    } catch (e) {
      // A redeclare keeps the current values rather than resetting them to defaults.
      warn(`${(e as Error).message}; ${live ? "keeping current values" : "using defaults"}`, undefined, (e as Error).message);
      raw = live && Object.fromEntries([...live.values].filter(([k, v]) => byKey.has(k) && !problem(byKey.get(k)!, v)));
    }
    if (raw !== undefined && !isObject(raw)) {
      warn(`${path}: section "${name}" must be an object; using defaults`, raw);
    } else if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const setting = byKey.get(key);
        const p = setting ? problem(setting, value) : "is not a known setting";
        if (p) warn(`${path}: ${name}.${key} ${p}; ${setting ? `using default ${JSON.stringify(setting.default)}` : "ignored"}`, value);
        else values.set(key, value as Value);
      }
    }
    const before = warned.get(name);
    for (const [id, message] of found) if (!before?.has(id)) pending.add(message);
    warned.set(name, new Set(found.keys()));

    if (live) {
      // Redeclared (/reload or another session): same handle, new schema and values, listeners kept.
      const old = live.values;
      Object.assign(live, { byKey, values });
      (live.section as { settings: readonly Setting[] }).settings = settings;
      // Changed and added keys carry their value; a removed key carries undefined.
      for (const [key, value] of values) if (old.get(key) !== value) notify(live, key, value);
      for (const key of old.keys()) if (!values.has(key)) notify(live, key, undefined);
      return live.section;
    }

    const state: Live = { byKey, values, listeners: new Set(), section: undefined! };
    const section: Section = (state.section = {
      name,
      settings,
      get: (key) => {
        if (!state.values.has(key)) throw new Error(`unknown rig setting ${name}.${key}`);
        return state.values.get(key)!;
      },
      values: () => Object.fromEntries(state.values),
      set: (key, value) => section.setMany({ [key]: value }),
      setMany(changes) {
        const entries = Object.entries(changes);
        for (const [key, value] of entries) {
          const setting = state.byKey.get(key);
          const p = setting ? problem(setting, value) : "is not a known setting";
          if (p) throw new Error(`rig setting ${name}.${key} ${p}`);
        }
        // Re-read so another session's changes to other keys survive.
        const current = read();
        const found = own(current, name);
        const sec = isObject(found) ? found : {};
        for (const [key, value] of entries) {
          if (value === state.byKey.get(key)!.default) delete sec[key];
          else put(sec, key, value);
        }
        if (Object.keys(sec).length) put(current, name, sec);
        else delete current[name];
        mkdirSync(agentDir, { recursive: true });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
        renameSync(tmp, path);
        for (const [key, value] of entries) {
          state.values.set(key, value);
          notify(state, key, value);
        }
      },
      reset(key) {
        const setting = state.byKey.get(key);
        if (!setting) throw new Error(`unknown rig setting ${name}.${key}`);
        section.set(key, setting.default);
      },
      onChange(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    });
    sections.set(name, state);
    return section;
  }

  function notify(live: Live, key: string, value: Value | undefined) {
    for (const l of live.listeners) l(key, value);
  }

  return {
    path,
    declare,
    sections: () => [...sections.values()].map((l) => l.section),
    notifyWarnings(ui) {
      for (const w of pending) ui.notify(w, "warning");
      pending.clear();
    },
  };
}

const KEY = Symbol.for("pi-rig.settings");

/**
 * The rig's single settings instance, shared by every extension through
 * globalThis. Pass Pi's `getAgentDir()`; the first call fixes the directory.
 */
export function rigSettings(agentDir: string): RigSettings {
  const g = globalThis as { [KEY]?: RigSettings };
  return (g[KEY] ??= createRigSettings(agentDir));
}
