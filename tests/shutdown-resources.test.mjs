// Shutdown resource guard (G3): a full-rig session (every extensions/*/index.ts, the
// same set package.json's extension glob loads) must leave no timer, watcher or child
// process behind once session_shutdown has run. process.getActiveResourcesInfo() names
// every libuv handle still keeping the process alive; a baseline taken before the rig
// loads at all tells the rig's own handles apart from Node's or node:test's own.
//
// scriptedSession (tests/helpers/session.mjs) normally shuts the session down and
// disposes it from its own t.after, which node:test runs only once every test in the
// file has finished. This test needs shutdown to happen mid-test, so it hands
// scriptedSession a stand-in `t` that just remembers the cleanup instead of scheduling
// it, and calls that cleanup itself before checking resources.
//
// scriptedSession's createAgentSession() does not itself fire session_start: Pi's own
// CLI does that by calling session.bindExtensions() once it has a mode and UI to hand
// extensions. Skipping that call would leave every session_start handler - where most
// of the rig sets up its timers and watchers - never having run, and this guard would
// pass by never exercising them. bindExtensions({}) binds "print" mode, no UI: enough
// to fire session_start for real without a terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import "./fixtures/tool-display/pi-tui.mjs";
import { scriptedSession } from "./helpers/session.mjs";
import { allExtensionPaths } from "./helpers/rig-registrations.mjs";

/** Resources in `after` not present in `baseline`, as a multiset: a resource kind the
 * baseline already had (Node's own stdio, node:test's own timers) is never "leaked"
 * just because it is still open, only a kind that appeared beyond the baseline's count. */
function newResources(baseline, after) {
  const counts = new Map();
  for (const r of baseline) counts.set(r, (counts.get(r) ?? 0) + 1);
  const extra = [];
  for (const r of after) {
    const n = counts.get(r) ?? 0;
    if (n > 0) counts.set(r, n - 1);
    else extra.push(r);
  }
  return extra;
}

test("a full-rig session leaves no timer, watcher or child process after shutdown", async (t) => {
  const baseline = process.getActiveResourcesInfo();

  let cleanup;
  const { session } = await scriptedSession(
    { after: (fn) => (cleanup = fn) }, // captured, not scheduled: see the file comment
    { extensions: allExtensionPaths() },
  );
  assert.equal(typeof cleanup, "function");
  await session.bindExtensions({}); // fires session_start on every loaded extension

  await cleanup(); // session_shutdown, then session.dispose(), then env/box cleanup

  // A handle can close asynchronously (its own close callback runs on a later tick);
  // give any in-flight close a moment rather than asserting on the very next tick.
  for (let i = 0; i < 20; i++) {
    if (newResources(baseline, process.getActiveResourcesInfo()).length === 0) break;
    await delay(25);
  }

  const leftover = newResources(baseline, process.getActiveResourcesInfo());
  assert.deepEqual(leftover, [], `resources still open after shutdown: ${JSON.stringify(leftover)}`);

  void session; // kept only so the session itself is not GC'd mid-shutdown above
});
