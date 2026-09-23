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
  onChange(listener: (key: string, value: Value) => void): () => void;
}

export interface RigSettings {
  readonly path: string;
  /** Declares (or redeclares, on /reload) a section, reading its values from the file. */
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
  const sections = new Map<string, Section>();
  const pending = new Set<string>();

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

  function declare(name: string, settings: readonly Setting[]): Section {
    const byKey = new Map(settings.map((s) => [s.key, s]));
    for (const s of settings) {
      const p = problem(s, s.default);
      if (p) throw new Error(`rig setting ${name}.${s.key}: default ${p}`);
    }

    const values = new Map<string, Value>(settings.map((s) => [s.key, s.default]));
    let file: Record<string, unknown> = {};
    try {
      file = read();
    } catch (e) {
      pending.add(`${(e as Error).message}; using defaults`);
    }
    const raw = own(file, name);
    if (raw !== undefined && !isObject(raw)) {
      pending.add(`${path}: section "${name}" must be an object; using defaults`);
    } else if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const setting = byKey.get(key);
        const p = setting ? problem(setting, value) : "is not a known setting";
        if (p) pending.add(`${path}: ${name}.${key} ${p}; ${setting ? `using default ${JSON.stringify(setting.default)}` : "ignored"}`);
        else values.set(key, value as Value);
      }
    }

    const listeners = new Set<(key: string, value: Value) => void>();
    const section: Section = {
      name,
      settings,
      get: (key) => {
        if (!values.has(key)) throw new Error(`unknown rig setting ${name}.${key}`);
        return values.get(key)!;
      },
      values: () => Object.fromEntries(values),
      set: (key, value) => section.setMany({ [key]: value }),
      setMany(changes) {
        if (sections.get(name) !== section) throw new Error(`rig section ${name} was redeclared; use the new handle`);
        const entries = Object.entries(changes);
        for (const [key, value] of entries) {
          const setting = byKey.get(key);
          const p = setting ? problem(setting, value) : "is not a known setting";
          if (p) throw new Error(`rig setting ${name}.${key} ${p}`);
        }
        // Re-read so another session's changes to other keys survive.
        const current = read();
        const found = own(current, name);
        const sec = isObject(found) ? found : {};
        for (const [key, value] of entries) {
          if (value === byKey.get(key)!.default) delete sec[key];
          else put(sec, key, value);
        }
        if (Object.keys(sec).length) put(current, name, sec);
        else delete current[name];
        mkdirSync(agentDir, { recursive: true });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
        renameSync(tmp, path);
        for (const [key, value] of entries) {
          values.set(key, value);
          for (const l of listeners) l(key, value);
        }
      },
      reset(key) {
        const setting = byKey.get(key);
        if (!setting) throw new Error(`unknown rig setting ${name}.${key}`);
        section.set(key, setting.default);
      },
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    sections.set(name, section);
    return section;
  }

  return {
    path,
    declare,
    sections: () => [...sections.values()],
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
