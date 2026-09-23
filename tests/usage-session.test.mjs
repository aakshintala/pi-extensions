// /usage in a scripted session (#61 review): a session shutdown while sessions
// are being collected aborts the collection, so it never writes the cache.
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedSession } from "./helpers/session.mjs";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const plain = { fg: (_k, t) => t, bold: (t) => t };

test("shutting down while /usage collects aborts the collection before it writes the cache", async (t) => {
  const { session, agentDir } = await scriptedSession(t, { extensions: [root("extensions/usage/index.ts")] });
  // An in-memory session has no folder of its own, so /usage reads <agentDir>/sessions.
  cpSync(root("tests/fixtures/usage/sessions"), join(agentDir, "sessions"), { recursive: true });
  session.extensionRunner.setUIContext(
    {
      notify() {},
      custom: (factory) =>
        new Promise((done) => {
          const loader = factory({ requestRender() {} }, plain, {}, done);
          // The session ends while the loader is up and the collection has just started.
          void session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          return loader;
        }),
    },
    "tui",
  );
  await session.prompt("/usage"); // returns once the collection has settled
  assert.equal(existsSync(join(agentDir, "usage-extension-cache.json")), false);
});
