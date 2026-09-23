// Background-work registry (spec #29): one list of running agents, shell jobs
// and monitors, shared by every extension through a globalThis symbol.
// Producers register, update and finish items; the fleet extension draws them.
// Producers never draw UI.

export type Kind = "agent" | "shell" | "monitor";
export type Status = "queued" | "running" | "completed" | "failed" | "stopped";
export type FinalStatus = "completed" | "failed" | "stopped";

/** What the viewer (#45) shows for an item: a transcript component or a log file read in increments. */
export type ItemView = { transcript(): unknown } | { log: string };

export interface ItemSpec {
  id: string;
  kind: Kind;
  label: string;
  /** Shows the item indented under this item. */
  parentId?: string;
  /** Defaults to "running". */
  status?: "queued" | "running";
  /** A short line of latest activity, read on every render. */
  activity(): string;
  view?: ItemView;
  stop(): void | Promise<void>;
  /** Agents only. */
  steer?(text: string): void | Promise<void>;
}

export interface Item extends Omit<ItemSpec, "status"> {
  status: Status;
  /** `fleet.now()` at registration. */
  startedAt: number;
  /** `fleet.now()` at finish. */
  endedAt?: number;
  /** Result summary given to `finish`. */
  result?: string;
}

export interface Fleet {
  /** Adds an item. Registering an existing id replaces it. */
  register(spec: ItemSpec): void;
  /** Changes an item's fields and redraws. Call with no change to redraw a new activity line. */
  update(id: string, change?: Partial<Pick<ItemSpec, "label" | "parentId" | "status">>): void;
  finish(id: string, status: FinalStatus, result: string): void;
  get(id: string): Item | undefined;
  /** In registration order. */
  items(): readonly Item[];
  /** Drops finished items. The fleet extension calls it when the user submits a prompt. */
  prune(): void;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Clock for running times, in ms. Tests replace it. */
  now: () => number;
}

export const isFinished = (s: Status) => s === "completed" || s === "failed" || s === "stopped";

export function createFleet(): Fleet {
  const items = new Map<string, Item>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const fleet: Fleet = {
    now: () => Date.now(),
    register(spec) {
      items.delete(spec.id);
      items.set(spec.id, { ...spec, status: spec.status ?? "running", startedAt: fleet.now() });
      changed();
    },
    update(id, change = {}) {
      const item = items.get(id);
      if (!item) return;
      Object.assign(item, change);
      changed();
    },
    finish(id, status, result) {
      const item = items.get(id);
      if (!item) return;
      Object.assign(item, { status, result, endedAt: fleet.now() });
      changed();
    },
    get: (id) => items.get(id),
    items: () => [...items.values()],
    prune() {
      const before = items.size;
      for (const [id, item] of items) if (isFinished(item.status)) items.delete(id);
      if (items.size !== before) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return fleet;
}

const KEY = Symbol.for("pi-rig.fleet");

/** The process's one registry, shared by every extension however Pi loads them. */
export function fleet(): Fleet {
  const g = globalThis as { [KEY]?: Fleet };
  return (g[KEY] ??= createFleet());
}
