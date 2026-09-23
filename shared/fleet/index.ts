// Background-work registry (spec #29): one list of running agents, shell jobs
// and monitors, shared by every extension through a globalThis symbol.
// Producers register, update and finish items; the fleet extension draws them.
// Producers never draw UI. Notices go to the session that owns the item, which
// the fleet extension of that session delivers to its model.

import { oneLine } from "../text/index.ts";

/** Most notices held for one owner that has not attached; the oldest are dropped. */
export const MAX_HELD = 50;

export type Kind = "agent" | "shell" | "monitor";
export type Status = "queued" | "running" | "completed" | "failed" | "stopped";
export type FinalStatus = "completed" | "failed" | "stopped";

/** What the viewer (#45) shows for an item: a transcript component or a log file read in increments. */
export type ItemView = { transcript(): unknown } | { log: string };

export interface ItemSpec {
  id: string;
  /** Session that started the item, `ctx.sessionManager.getSessionId()`: its notices go there, and it waits for the item before ending. */
  owner: string;
  kind: Kind;
  label: string;
  /** Shows the item indented under this item. */
  parentId?: string;
  /** Defaults to "running". */
  status?: "queued" | "running";
  /** A short line of latest activity, read on every render. */
  activity(): string;
  view: ItemView;
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

/** A notice as the owning session receives it. `text` is what the model reads. */
export interface Notice {
  text: string;
  /** Snapshot of the item for the user-facing line; `ms` is its running time. */
  item: Pick<Item, "id" | "kind" | "label" | "status" | "result"> & { ms: number };
}

export interface Fleet {
  /** Adds an item. Registering an existing id replaces it. Throws for the id "main", which is the main session's row. */
  register(spec: ItemSpec): void;
  /** Changes an item's fields and redraws. Call with no change to redraw a new activity line. Ignored once the item is finished. */
  update(id: string, change?: Partial<Pick<ItemSpec, "label" | "parentId" | "status">>): void;
  /**
   * `result` is the user's summary; a failed or stopped result carries the error or reason.
   * `notice` is the model's line, delivered with `notify`: omitted, a default line built from
   * the item; `null`, none (the model already has the result).
   */
  finish(id: string, status: FinalStatus, result: string, notice?: string | null): void;
  /** Sends `text` to the item's owner session: it starts a turn when idle and joins the running turn otherwise. Held until the owner attaches. */
  notify(id: string, text: string): void;
  /** The fleet extension's delivery for one session; notices held for it are delivered now. Returns a detach function; notices for a detached owner, or one whose sink threw, are dropped until it attaches again. */
  attach(owner: string, deliver: (notice: Notice) => void): () => void;
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

/** Running time as `5s`, `1m05s` or `1h02m`. */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export const isFinished = (s: Status) => s === "completed" || s === "failed" || s === "stopped";

export function createFleet(): Fleet {
  const items = new Map<string, Item>();
  const listeners = new Set<() => void>();
  const sinks = new Map<string, (notice: Notice) => void>();
  const held = new Map<string, Notice[]>(); // for owners not attached yet
  const gone = new Set<string>(); // detached owners: their notices are dropped
  const send = (owner: string, notice: Notice) => {
    const deliver = sinks.get(owner);
    if (!deliver) {
      if (!gone.has(owner)) held.set(owner, [...(held.get(owner) ?? []), notice].slice(-MAX_HELD));
      return;
    }
    try {
      deliver(notice);
    } catch {
      // A disposed session's sink: drop the notice and detach it.
      sinks.delete(owner);
      gone.add(owner);
    }
  };
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const fleet: Fleet = {
    now: () => Date.now(),
    register(spec) {
      if (spec.id === "main") throw new Error('fleet: the id "main" is reserved for the main session');
      items.delete(spec.id);
      items.set(spec.id, { ...spec, status: spec.status ?? "running", startedAt: fleet.now() });
      changed();
    },
    update(id, change = {}) {
      const item = items.get(id);
      if (!item || isFinished(item.status)) return;
      Object.assign(item, change);
      changed();
    },
    finish(id, status, result, notice) {
      const item = items.get(id);
      if (!item) return;
      Object.assign(item, { status, result, endedAt: fleet.now() });
      changed();
      if (notice === null) return;
      fleet.notify(id, notice ?? `${oneLine(item.kind)} ${oneLine(item.label)} (id ${oneLine(id)}) ${status} after ${duration(item.endedAt! - item.startedAt)}: ${oneLine(result)}`);
    },
    notify(id, text) {
      const item = items.get(id);
      if (!item) return;
      const { kind, label, status, result } = item;
      send(item.owner, { text, item: { id, kind, label, status, result, ms: (item.endedAt ?? fleet.now()) - item.startedAt } });
    },
    attach(owner, deliver) {
      sinks.set(owner, deliver);
      gone.delete(owner);
      const notices = held.get(owner) ?? [];
      held.delete(owner);
      for (const notice of notices) send(owner, notice);
      return () => {
        if (sinks.get(owner) !== deliver) return;
        sinks.delete(owner);
        gone.add(owner);
      };
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
