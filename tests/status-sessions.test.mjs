// The #52 subagent shape for the status extension: a parent session and N
// in-process child sessions in one agent directory share the "status" rig.json
// section (#95). Each ended session must take its settings listener with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedSession } from "./helpers/session.mjs";
import { rigSettings } from "../shared/settings/index.ts";
import "./fixtures/tool-display/pi-tui.mjs"; // before the extension, which draws with pi-tui
const { default: status } = await import("../extensions/status/index.ts");

test("one set reaches only the live sessions' quota listeners", async (t) => {
  const heard = [];
  let who = "parent";
  const parent = (pi) => {
    // Declared empty first so the listener spy is in place before status registers; status redeclares the same handle.
    const section = rigSettings(getAgentDir()).declare("status", []);
    const onChange = section.onChange;
    section.onChange = (listener) => {
      const me = who;
      return onChange((key, value) => (heard.push(me), listener(key, value)));
    };
    status(pi);
  };
  const { session, faux, cwd, agentDir } = await scriptedSession(t, { extensions: [parent] });

  const child = async (name) => {
    who = name;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, extensionFactories: [(pi) => status(pi)],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session: s } = await createAgentSession({
      cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime: session.modelRuntime,
      resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
    });
    return s;
  };
  const shutdown = async (s) => {
    await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); // idempotent
    s.dispose();
  };

  const [a, b, c] = [await child("a"), await child("b"), await child("c")];
  try {
    await shutdown(a);
    await shutdown(c);
    rigSettings(agentDir).sections().find((x) => x.name === "status").set("quotaRefreshSeconds", 30);
    assert.deepEqual(heard.sort(), ["b", "parent"]);
  } finally {
    await shutdown(b);
  }
});
