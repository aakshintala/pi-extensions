import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Background processes + structured return (issue #11, part of #1).
// One lifecycle: bash launches (foreground, or background into the
// per-session job table), jobs manages (list/output/wait/kill). No
// monitor/bash_bg/agent_bg model tools. Structured return is separate:
// it waits, always stores the full log, resolves a named parser, and
// returns compact output plus the log path.

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
// Foreground runs keep this much in memory; beyond it the stream spills
// to the temp log mid-run. Above the display limits, so a spilled run is
// always a truncated run and its file always exists.
const SPILL_BYTES = 1024 * 1024;
// Background jobs keep only a tail: beyond this the head is dropped and
// the output action says so. Full-log preservation is structured
// return's job, not the job table's.
const JOB_KEEP_BYTES = 256 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round((bytes / 1024) * 10) / 10}KB`;
}

export interface Truncation {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  maxLines: number;
  maxBytes: number;
}

// Last maxLines/maxBytes of text, head-aligned to a line boundary.
// Never returns a partial head line, except when one line alone exceeds
// maxBytes (lastLinePartial), mirroring the upstream tail edge case.
export function tailTruncate(
  text: string,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES,
): Truncation {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text === "" ? [] : text.split("\n");
  const totalLines = lines.length;
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf8") + 1;
    if (bytes + size > maxBytes) break;
    kept.unshift(lines[i]);
    bytes += size;
  }
  if (kept.length === 0 && lines.length > 0) {
    const buf = Buffer.from(text, "utf8").subarray(-maxBytes);
    const start = buf.indexOf(0x0a) + 1;
    const content = buf.subarray(start).toString("utf8");
    return {
      content,
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: content.split("\n").length,
      outputBytes: maxBytes - start,
      lastLinePartial: true,
      maxLines,
      maxBytes,
    };
  }
  const content = kept.join("\n");
  const truncated = kept.length < lines.length;
  return {
    content,
    truncated,
    truncatedBy: !truncated ? null : kept.length >= maxLines ? "lines" : "bytes",
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(content, "utf8"),
    lastLinePartial: false,
    maxLines,
    maxBytes,
  };
}

export interface Collected {
  // Display tail: the kept window of output.
  tail: string;
  totalBytes: number;
  totalLines: number;
  // True when the head was dropped (background jobs past their buffer).
  overflowed: boolean;
  // Full bytes on disk, not the tail. Present once spilled, always for
  // structured return, or when finish() persists a truncated run.
  logPath?: string;
}

// Bounded streaming collector: exact byte/line counts, an in-memory tail
// window, and spill of the full stream to a temp log. snapshot() is
// non-destructive (background jobs keep streaming); finish() snapshots
// and optionally persists a truncated memory-only run.
export function createCollector(
  prefix: string,
  mode: "on-spill" | "always" | "never",
  keepBytes: number = SPILL_BYTES,
) {
  let chunks: Buffer[] = [];
  let keptBytes = 0;
  let droppedBytes = 0;
  let totalBytes = 0;
  let newlines = 0;
  let endsWithNewline = true;
  let logPath: string | undefined;
  let stream: { write: (d: Buffer) => void } | undefined;
  let opened: Promise<void> | undefined;

  async function openSpill(): Promise<void> {
    if (opened) return opened;
    opened = (async () => {
      const { createWriteStream } = await import("node:fs");
      logPath = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
      const out = createWriteStream(logPath);
      stream = { write: (d: Buffer) => void out.write(d) };
      for (const c of chunks) stream.write(c);
      // Memory keeps only the tail window from here on; the file holds
      // the full stream, so display tails stay available for huge runs.
    })();
    return opened;
  }

  function snapshot(): Collected {
    let tail = Buffer.concat(chunks).toString("utf8");
    if (droppedBytes > 0 || stream) {
      const nl = tail.indexOf("\n");
      if (nl >= 0) tail = tail.slice(nl + 1);
    }
    return {
      tail,
      totalBytes,
      totalLines: newlines + (totalBytes > 0 && !endsWithNewline ? 1 : 0),
      overflowed: droppedBytes > 0,
      logPath,
    };
  }

  return {
    async append(data: Buffer): Promise<void> {
      if (data.length === 0) return;
      totalBytes += data.length;
      endsWithNewline = data[data.length - 1] === 0x0a;
      for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) newlines++;
      if (mode === "always") await openSpill();
      else if (mode === "on-spill" && totalBytes > SPILL_BYTES) await openSpill();
      if (stream) stream.write(data);
      chunks.push(data);
      keptBytes += data.length;
      if (keptBytes > keepBytes) {
        const buf = Buffer.concat(chunks);
        const cut = buf.subarray(0, keptBytes - keepBytes);
        const nl = cut.lastIndexOf(0x0a) + 1;
        chunks = [buf.subarray(nl)];
        droppedBytes += nl;
        keptBytes = chunks[0].length;
      }
    },
    snapshot,
    async finish(persistIfTruncated = false): Promise<Collected> {
      if (mode === "always") await openSpill();
      const snap = snapshot();
      if (persistIfTruncated && !snap.logPath && (snap.totalLines > MAX_LINES || snap.totalBytes > MAX_BYTES)) {
        snap.logPath = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
        await writeFile(snap.logPath, Buffer.concat(chunks));
        logPath = snap.logPath;
      }
      return snap;
    },
  };
}

export interface RunResult extends Collected {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
}

// Spawn via the system shell, stream into a collector, wait for exit.
// Timeout kills and reports; an aborted signal kills and reports.
export async function runCommand(opts: {
  command: string;
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
  logPrefix: string;
  logMode: "on-spill" | "always" | "never";
}): Promise<RunResult> {
  const collector = createCollector(opts.logPrefix, opts.logMode);
  const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: process.env });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on("error", () => resolve({ exitCode: null, signal: null }));
    child.on("close", (code, sig) => resolve({ exitCode: code, signal: sig }));
  });
  child.stdout?.on("data", (d: Buffer) => void collector.append(d));
  child.stderr?.on("data", (d: Buffer) => void collector.append(d));
  let timedOut = false;
  let aborted = false;
  if (opts.signal?.aborted) {
    aborted = true;
    child.kill("SIGKILL");
  } else {
    if (opts.timeout != null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeout * 1000);
      timer.unref?.();
    }
    if (opts.signal) {
      const signal = opts.signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          aborted = true;
          child.kill("SIGKILL");
          resolve();
          return;
        }
        onAbort = () => {
          aborted = true;
          child.kill("SIGKILL");
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        done.then(() => resolve());
      });
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
  const end = await done;
  if (timer) clearTimeout(timer);
  // Drain output flushed between kill and close.
  await new Promise((r) => setTimeout(r, 10));
  const collected = await collector.finish(true);
  return { ...collected, ...end, timedOut, aborted };
}

export type JobStatus = "running" | "exited" | "killed";

export interface JobSnapshot {
  id: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
}

// Per-session background job table. Jobs start from bash
// run_in_background and are managed through the jobs tool; shutdown kills
// whatever is still running. Ids count up from 1 within the session.
export function createSessionJobs() {
  let next = 1;
  const jobs = new Map<
    string,
    {
      command: string;
      child: ReturnType<typeof spawn>;
      collector: ReturnType<typeof createCollector>;
      done: Promise<{ exitCode: number | null; signal: string | null }>;
      status: JobStatus;
      exitCode: number | null;
      signal: string | null;
    }
  >();

  function snapshot(id: string): JobSnapshot {
    const j = jobs.get(id);
    if (!j) throw new Error(`Unknown job: ${id}`);
    return { id, command: j.command, status: j.status, exitCode: j.exitCode, signal: j.signal };
  }

  return {
    start(command: string, cwd: string): { id: string; pid: number | undefined } {
      const id = String(next++);
      const collector = createCollector("pi-jobs", "never", JOB_KEEP_BYTES);
      const child = spawn(command, { cwd, shell: true, env: process.env });
      const record = {
        command,
        child,
        collector,
        done: Promise.resolve({ exitCode: null as number | null, signal: null as string | null }),
        status: "running" as JobStatus,
        exitCode: null as number | null,
        signal: null as string | null,
      };
      record.done = new Promise((resolve) => {
        child.on("error", () => {
          if (record.status === "running") record.status = "exited";
          resolve({ exitCode: record.exitCode, signal: record.signal });
        });
        child.on("close", (code, sig) => {
          if (record.status === "running") {
            record.status = "exited";
            record.exitCode = code;
            record.signal = sig;
          }
          resolve({ exitCode: record.exitCode, signal: record.signal });
        });
      });
      child.stdout?.on("data", (d: Buffer) => void collector.append(d));
      child.stderr?.on("data", (d: Buffer) => void collector.append(d));
      jobs.set(id, record);
      return { id, pid: child.pid };
    },
    list(): JobSnapshot[] {
      return [...jobs.keys()].map((id) => snapshot(id));
    },
    peek(id: string): { snap: JobSnapshot; collected: Collected } {
      const j = jobs.get(id);
      if (!j) throw new Error(`Unknown job: ${id}`);
      return { snap: snapshot(id), collected: j.collector.snapshot() };
    },
    async wait(
      id: string,
      timeout?: number,
    ): Promise<{ snap: JobSnapshot; collected: Collected; timedOut: boolean }> {
      const j = jobs.get(id);
      if (!j) throw new Error(`Unknown job: ${id}`);
      let timedOut = false;
      if (timeout != null) {
        const winner = await Promise.race([
          j.done.then(() => "done" as const),
          new Promise((r) => setTimeout(() => r("timeout" as const), timeout * 1000)),
        ]);
        timedOut = winner === "timeout";
      } else {
        await j.done;
      }
      // Drain output flushed around exit before snapshotting.
      await new Promise((r) => setTimeout(r, 10));
      return { snap: snapshot(id), collected: j.collector.snapshot(), timedOut };
    },
    kill(id: string): JobSnapshot {
      const j = jobs.get(id);
      if (!j) throw new Error(`Unknown job: ${id}`);
      if (j.status !== "running") return snapshot(id);
      j.status = "killed";
      j.child.kill("SIGKILL");
      return snapshot(id);
    },
    shutdown(): void {
      for (const j of jobs.values()) {
        if (j.status === "running") {
          j.status = "killed";
          try {
            j.child.kill("SIGKILL");
          } catch {
            // Already gone; status already records the kill.
          }
        }
      }
      jobs.clear();
    },
  };
}

export type SessionJobs = ReturnType<typeof createSessionJobs>;

// TAP summary for test output: pass count plus the failing test names.
// Representative structured parser; anything else falls back to tail.
export function parseTap(log: string): string {
  let pass = 0;
  const failed: string[] = [];
  let planned: number | undefined;
  for (const line of log.split("\n")) {
    const t = line.trim();
    const plan = /^1\.\.(\d+)/.exec(t);
    if (plan) planned = Number(plan[1]);
    else if (/^not ok\b/.test(t)) failed.push(t.replace(/^not ok\s+\d*\s*/, "").trim() || "(unnamed test)");
    else if (/^ok\b/.test(t)) pass += 1;
  }
  const total = pass + failed.length;
  const head = `TAP: ${pass}/${total} passed${planned !== undefined && planned !== total ? ` (plan 1..${planned})` : ""}`;
  return failed.length > 0 ? `${head}\nFailed:\n${failed.slice(0, 20).map((f) => `- ${f}`).join("\n")}` : head;
}

const PARSERS: Record<string, (log: string) => string> = { tap: parseTap };

export function resolveParser(name: string | undefined): { name: string; note?: string } {
  if (!name || name === "tail") return { name: "tail" };
  if (PARSERS[name]) return { name };
  return { name: "tail", note: `Unknown parser "${name}", used tail.` };
}

export function applyParser(name: string, log: string, maxLines = MAX_LINES): string {
  if (name === "tail") return tailTruncate(log, maxLines).content;
  return PARSERS[name](log);
}

// Model-facing text for a finished command: tail window plus the same
// truncation notice the built-in bash used, so log access survives the
// override. Totals describe the run; content is cut from the kept tail.
export function formatOutput(
  collected: Collected,
  emptyText = "(no output)",
): { text: string; details: { truncation?: Truncation; fullOutputPath?: string } } {
  const window = tailTruncate(collected.tail);
  const truncated = collected.totalLines > window.maxLines || collected.totalBytes > window.maxBytes;
  const full: Truncation = {
    ...window,
    totalLines: collected.totalLines,
    totalBytes: collected.totalBytes,
    truncated,
    truncatedBy: !truncated ? null : window.truncated ? window.truncatedBy : "bytes",
  };
  let text = window.content || emptyText;
  const details: { truncation?: Truncation; fullOutputPath?: string } = {};
  if (truncated) {
    details.truncation = full;
    details.fullOutputPath = collected.logPath;
    const startLine = Math.max(1, full.totalLines - window.outputLines + 1);
    text += `\n\n[Showing lines ${startLine}-${full.totalLines} of ${full.totalLines}. Full output: ${collected.logPath}]`;
  }
  return { text, details };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

function statusLine(snap: JobSnapshot): string {
  if (snap.status === "running") return "running";
  if (snap.status === "killed") return `killed${snap.signal ? ` (${snap.signal})` : ""}`;
  return `exited ${snap.exitCode ?? "without an exit code"}`;
}

type Ctx = Pick<ExtensionContext, "cwd" | "sessionManager" | "signal">;

// Session key: the shared sessionManager object when present, else the
// ctx object itself. Never a module-global table value.
function storeFor(stores: WeakMap<object, SessionJobs>, ctx: Ctx | undefined): SessionJobs {
  const key = ctx?.sessionManager ?? ctx;
  if (!key || (typeof key !== "object" && typeof key !== "function")) {
    throw new Error("Background jobs require a session context");
  }
  let store = stores.get(key as object);
  if (!store) {
    store = createSessionJobs();
    stores.set(key as object, store);
  }
  return store;
}

const bashParameters = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
    run_in_background: {
      type: "boolean",
      description: "Launch in the background and return a job id for jobs instead of waiting",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

const jobsParameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "output", "wait", "kill"], description: "Job action" },
    jobId: { type: "string", description: "Job id from bash run_in_background (not needed for list)" },
    timeout: { type: "number", description: "Seconds for wait to report still-running instead of exiting" },
    maxLines: { type: "number", description: "Tail lines for output (default 200)" },
  },
  required: ["action"],
  additionalProperties: false,
};

const structuredParameters = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run to completion" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
    parseAs: { type: "string", description: "Named parser for the full log (tap); anything else uses tail" },
    maxLines: { type: "number", description: "Tail window for the default parser (default 2000)" },
  },
  required: ["command"],
  additionalProperties: false,
};

export function createTools(stores: WeakMap<object, SessionJobs>): Array<{
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  constrainedSampling?: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Ctx,
  ) => Promise<ToolResult>;
}> {
  return [
    {
      name: "bash",
      label: "bash",
      description:
        "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. With run_in_background, launches into the session job table and returns a job id for jobs instead of waiting.",
      promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
      promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
      parameters: bashParameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        if (params.run_in_background) {
          const store = storeFor(stores, ctx);
          const { id, pid } = store.start(params.command, cwd);
          return {
            content: [
              { type: "text", text: `Started background job ${id}${pid ? ` (pid ${pid})` : ""}: ${params.command}` },
            ],
            details: { jobId: id },
          };
        }
        const end = await runCommand({
          command: params.command,
          cwd,
          timeout: params.timeout,
          signal: signal ?? ctx?.signal ?? undefined,
          logPrefix: "pi-bash",
          logMode: "on-spill",
        });
        if (end.aborted) throw new Error("Command aborted");
        if (end.timedOut) {
          const { text } = formatOutput(end, "");
          throw new Error(`${text ? `${text}\n\n` : ""}Command timed out after ${params.timeout} seconds`);
        }
        const { text, details } = formatOutput(end);
        if (end.exitCode === null) throw new Error(`${text}\n\nCommand terminated without an exit code`);
        if (end.exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${end.exitCode}`);
        return { content: [{ type: "text", text }], details };
      },
    },
    {
      name: "jobs",
      label: "jobs",
      description:
        "Manage background processes started by bash run_in_background. Actions: list jobs, output (tail of a job log), wait (until a job exits), kill. One lifecycle with bash; no separate background tools.",
      parameters: jobsParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const store = storeFor(stores, ctx);
        if (params.action === "list") {
          const all = store.list();
          return {
            content: [
              {
                type: "text",
                text:
                  all.length === 0
                    ? "No background jobs"
                    : all.map((s) => `${s.id} [${statusLine(s)}] ${s.command}`).join("\n"),
              },
            ],
            details: { jobs: all },
          };
        }
        if (!params.jobId) throw new Error(`jobs ${params.action} requires jobId`);
        if (params.action === "kill") {
          const snap = store.kill(params.jobId);
          return {
            content: [{ type: "text", text: `Job ${snap.id} ${statusLine(snap)}: ${snap.command}` }],
            details: { job: snap },
          };
        }
        if (params.action === "wait") {
          const { snap, collected, timedOut } = await store.wait(params.jobId, params.timeout);
          if (timedOut) {
            const view = tailTruncate(collected.tail, params.maxLines ?? MAX_LINES).content || "(no output yet)";
            return {
              content: [{ type: "text", text: `Job ${snap.id} still ${statusLine(snap)}: ${snap.command}\n\n${view}` }],
              details: { job: snap, timedOut: true },
            };
          }
          const { text, details } = formatOutput(collected);
          if (snap.status === "killed") {
            return {
              content: [{ type: "text", text: `Job ${snap.id} ${statusLine(snap)}: ${snap.command}\n\n${text}` }],
              details: { job: snap, ...details },
            };
          }
          if (snap.exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${snap.exitCode}`);
          return {
            content: [{ type: "text", text: `Job ${snap.id} ${statusLine(snap)}: ${snap.command}\n\n${text}` }],
            details: { job: snap, ...details },
          };
        }
        if (params.action === "output") {
          const { snap, collected } = store.peek(params.jobId);
          const view = tailTruncate(collected.tail, params.maxLines ?? 200).content || "(no output yet)";
          const overflow = collected.overflowed
            ? "\n\n[Job output exceeds the in-memory buffer; showing the tail.]"
            : "";
          return {
            content: [{ type: "text", text: `Job ${snap.id} [${statusLine(snap)}]: ${snap.command}\n\n${view}${overflow}` }],
            details: { job: snap },
          };
        }
        throw new Error(`Unknown jobs action: ${params.action}`);
      },
    },
    {
      name: "structured_return",
      label: "structured_return",
      description:
        "Run a command to completion and return compact output plus the full-log path. Always stores the full log; resolves a named parser (tap) or falls back to tail. Separate from bash: parser behavior never complicates bash.",
      parameters: structuredParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const end = await runCommand({
          command: params.command,
          cwd,
          timeout: params.timeout,
          signal: signal ?? ctx?.signal ?? undefined,
          logPrefix: "pi-structured",
          logMode: "always",
        });
        if (!end.logPath) throw new Error("Structured run produced no log file");
        const full = await readFile(end.logPath, "utf8").catch(() => end.tail);
        const resolved = resolveParser(params.parseAs);
        const compact = applyParser(resolved.name, full, params.maxLines).trim() || "(no output)";
        const head = resolved.note ? `${resolved.note}\n` : "";
        if (end.aborted) throw new Error(`${head}${compact}\n\nCommand aborted\nFull log: ${end.logPath}`);
        if (end.timedOut) {
          throw new Error(`${head}${compact}\n\nCommand timed out after ${params.timeout} seconds\nFull log: ${end.logPath}`);
        }
        if (end.exitCode !== 0) {
          throw new Error(`${head}${compact}\n\nCommand exited with code ${end.exitCode ?? "unknown"}\nFull log: ${end.logPath}`);
        }
        return {
          content: [{ type: "text", text: `${head}${compact}\nFull log: ${end.logPath}` }],
          details: { parser: resolved.name, logPath: end.logPath },
        };
      },
    },
  ];
}

export default function (pi: ExtensionAPI) {
  // Per-session job tables, keyed by session identity. No module-global
  // table value: sessions never see each other's jobs.
  const stores = new WeakMap<object, SessionJobs>();
  for (const tool of createTools(stores)) {
    pi.registerTool(tool as never);
  }
  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent: unknown sessions and repeated shutdowns are no-ops.
    const key = (ctx as Ctx)?.sessionManager ?? ctx;
    if (key && (typeof key === "object" || typeof key === "function")) {
      stores.get(key as object)?.shutdown();
      stores.delete(key as object);
    }
  });
}
