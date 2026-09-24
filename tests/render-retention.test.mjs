// #154 regression guard (G1): every renderer the rig registers must let go of its
// render context once Pi (or here, the test) is done redrawing it, or unused chat
// history accumulates in memory for the life of the session. Renderers are found
// through the rig's own registration (tests/helpers/rig-registrations.mjs loads every
// extensions/*/index.ts for real), not a hand list, so a new renderer is covered the
// day it registers.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./fixtures/tool-display/pi-tui.mjs";
import { loadRig } from "./helpers/rig-registrations.mjs";
import { forceGC } from "./helpers/gc.mjs";

const theme = { fg: (_key, text) => text, bold: (text) => text };

// A tick lets WeakRefs clear (they only do so after the current job), then gc().
const settle = () => new Promise((r) => setImmediate(r));

// ---- tool call/result renderers (shared/tool-display, extensions/tool-display) ----
//
// Pi hands a redrawn tool row's previous Component back as `context.lastComponent`
// (see shared/tool-display/index.ts's own "no closure here may read context" comment):
// a renderCall/renderResult that closes over the whole context instead of copying out
// the fields it needs chains one context to the next through that link, and nothing in
// the chain is ever freed, because each still-live Component holds the one before it.
let probeId = 0;
const toolContext = (over = {}) => ({
  toolCallId: `probe-${probeId++}`,
  args: {},
  invalidate() {},
  lastComponent: undefined,
  state: {},
  cwd: "/w",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: true,
  isError: false,
  ...over,
});

// Redraws `render` REDRAWS times, threading each call's Component back in as the next
// context's lastComponent, the way Pi actually redraws a tool row. Returns a WeakRef to
// the first redraw's context and the last Component, the one thing Pi would still hold.
// A higher count than #154's test (5) doubles as the "stays constant per chunk" check:
// if a context leaked, this loop would retain REDRAWS of them, not just the first.
const REDRAWS = 20;
function chainedRedraws(render) {
  let last, first;
  for (let i = 0; i < REDRAWS; i++) {
    const ctx = toolContext({ lastComponent: last });
    first ??= new WeakRef(ctx);
    last = render(ctx);
  }
  return { first, last };
}

// Each check's context-like object is built and handed to the renderer inside its own
// function, never a variable the outer test keeps around: once the function returns,
// the only surviving path to that object is whatever the returned Component's closures
// still hold. A flat loop's `const` bindings stay reachable off the interpreter's stack
// until the whole test function returns, which is enough for V8 to keep them past gc().
function toolCheck(render) {
  const { first, last } = chainedRedraws(render);
  return { ref: first, keep: last };
}
function messageCheck(renderer) {
  const options = { expanded: false, outputPad: 0 };
  const component = renderer({ content: "probe", details: undefined }, options, theme);
  return component && { ref: new WeakRef(options), keep: component };
}
function entryCheck(renderer) {
  const options = { expanded: false };
  const component = renderer({ data: { version: 1, startedAt: 0, endedAt: 1000 } }, options, theme);
  return component && { ref: new WeakRef(options), keep: component };
}

test("every renderer the rig registers releases its render context once GC runs", async (t) => {
  const { extensions, errors } = await loadRig(t);
  assert.deepEqual(errors, [], "every rig extension loads cleanly");

  // { label, ref: WeakRef(context-like object), keep: the Component still "on screen" }
  const checks = [];

  for (const ext of extensions) {
    for (const [name, { definition }] of ext.tools) {
      if (definition.renderCall) {
        checks.push({ label: `tool ${name} renderCall`, ...toolCheck((ctx) => definition.renderCall({}, theme, ctx)) });
      }
      if (definition.renderResult) {
        const result = { content: [{ type: "text", text: "ok" }] };
        checks.push({ label: `tool ${name} renderResult`, ...toolCheck((ctx) => definition.renderResult(result, { expanded: false, isPartial: false }, theme, ctx)) });
      }
    }
    for (const [type, renderer] of ext.messageRenderers) {
      const check = messageCheck(renderer);
      if (check) checks.push({ label: `message ${type}`, ...check });
    }
    for (const [type, renderer] of ext.entryRenderers ?? []) {
      const check = entryCheck(renderer);
      if (check) checks.push({ label: `entry ${type}`, ...check });
    }
  }

  // Sanity check: this rig registers renderers of every kind the test claims to cover.
  const labelled = (prefix) => checks.some((c) => c.label.startsWith(prefix));
  assert.ok(labelled("tool "), "no tool renderer was found to check");
  assert.ok(labelled("message "), "no message renderer was found to check");
  assert.ok(labelled("entry "), "no entry renderer was found to check");

  await settle();
  forceGC();
  for (const { label, ref, keep } of checks) {
    assert.equal(ref.deref(), undefined, `${label} still retains its render context after GC`);
    assert.doesNotThrow(() => keep.render(80), `${label}'s retained Component no longer renders`);
  }
});

// ---- above-editor widgets (todo, queue) ----
//
// Widgets are not part of the registration maps above: an extension gets its widget's
// render context only by calling ctx.ui.setWidget(name, factory) itself, from inside a
// handler such as session_start, so there is no map to loop over generically the way
// tools and message/entry renderers have. todo and queue each get their own check below,
// built from the same stand-in ExtensionContext (mode "tui", hasUI true) and the real
// session_start/session_shutdown handlers loadRig() captured from their real modules.
function widgetCtx(over = {}) {
  const widgets = new Map();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/w",
    sessionManager: {
      getSessionId: () => "probe-session",
      getBranch: () => [],
      getEntries: () => [],
      buildContextEntries: () => [],
    },
    ui: {
      setWidget: (name, factory) => widgets.set(name, factory),
      onTerminalInput: () => () => {},
      notify() {},
      setEditorText() {},
      getEditorText: () => "",
    },
    isIdle: () => true,
    signal: undefined,
    ...over,
  };
  return { ctx, widgets };
}

// The ctx used to reach a widget factory is built and used inside this helper only,
// never held by a variable in the test body: once it returns, the sole surviving path
// to that ctx is whatever the returned Component's closures still hold. Returns only a
// WeakRef to the ctx and whether a real (not `undefined`) widget factory was set: never
// the component itself, since it closes over ctx by design (its click handler calls
// `draw(ctx)` again), and holding it in the caller's scope would keep ctx artificially
// reachable regardless of whether Pi still has that particular component on screen.
async function draw(handlers, branch) {
  const { ctx, widgets } = widgetCtx({
    sessionManager: { getSessionId: () => "s", getBranch: () => branch, getEntries: () => [], buildContextEntries: () => [] },
  });
  for (const handler of handlers) await handler({ type: "session_start", reason: "start" }, ctx);
  const component = widgets.get("todo")?.({ requestRender() {} }, theme); // realize the factory, like Pi does
  return { ref: new WeakRef(ctx), ok: !!component };
}

test("the todo widget releases an old draw()'s context once a later one replaces it", async (t) => {
  const { extensions } = await loadRig(t);
  const todo = extensions.find((e) => e.path.endsWith("/extensions/todo/index.ts"));
  assert.ok(todo, "todo extension not found");
  const handlers = todo.handlers.get("session_start") ?? [];
  assert.ok(handlers.length, "todo registered no session_start handler");

  // todo replaces its whole widget (a fresh factory via ctx.ui.setWidget) on every
  // draw(): session_start, session_tree, todo_write, /todos and before_agent_start
  // all call it again. Once a later draw's factory replaces the first (as Pi's own
  // setWidget does), nothing should still be holding the first draw's ctx.
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo_write", isError: false, details: { todos: [{ text: "a", status: "pending" }] } } },
  ];
  const { ref, ok } = await draw(handlers, branch);
  assert.ok(ok, "todo never set its widget with the stand-in ctx");
  const { ok: ok2 } = await draw(handlers, branch);
  assert.ok(ok2);

  await settle();
  forceGC();
  assert.equal(ref.deref(), undefined, "todo kept the previous draw()'s context alive after its widget was replaced");
});

async function startAndStopQueue(queue) {
  const { ctx, widgets } = widgetCtx();
  for (const handler of queue.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "start" }, ctx);
  const component = widgets.get("queue")?.({ requestRender() {} }, theme);
  const ref = new WeakRef(ctx);
  for (const handler of queue.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
  return { ref, component };
}

test("the queue widget releases its session context at shutdown", async (t) => {
  const { extensions } = await loadRig(t);
  const queue = extensions.find((e) => e.path.endsWith("/extensions/queue/index.ts"));
  assert.ok(queue, "queue extension not found");

  const { ref, component } = await startAndStopQueue(queue);
  assert.ok(component, "queue never set its widget with the stand-in ctx");
  assert.doesNotThrow(() => component.render(80));

  await settle();
  forceGC();
  assert.equal(ref.deref(), undefined, "queue kept its session context alive after shutdown");
});
