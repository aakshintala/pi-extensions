// The #52 subagent shape: a parent session and an in-process child session in
// the same agent directory both run the same extension factory, so each
// declares the same rig.json section. The parent's handle and listeners must
// stay live after the child redeclares, and the child's leave with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { scriptedSession } from "./helpers/session.mjs";
import { rigSettings } from "../shared/settings/index.ts";

const DECL = [{ key: "refreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Refresh" }];

test("a child session's redeclare leaves the parent's handle and listeners live", async (t) => {
  const heard = [];
  const handles = {};
  const extension = (who) => (pi) => {
    const section = rigSettings(getAgentDir()).declare("lane", DECL);
    handles[who] = section;
    const off = section.onChange((key, value) => heard.push([who, key, value]));
    pi.on("session_shutdown", off);
  };
  const { session, faux, cwd, agentDir } = await scriptedSession(t, { extensions: [extension("parent")] });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories: [extension("child")],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session: child } = await createAgentSession({
    cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime: session.modelRuntime,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
  });

  handles.parent.set("refreshSeconds", 30);
  const [menu] = rigSettings(agentDir).sections(); // what /rig edits
  menu.set("refreshSeconds", 90);
  assert.equal(handles.parent.get("refreshSeconds"), 90);
  assert.equal(handles.child.get("refreshSeconds"), 90);

  await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  child.dispose();
  handles.child.set("refreshSeconds", 120);
  assert.deepEqual(heard, [
    ["parent", "refreshSeconds", 30], ["child", "refreshSeconds", 30],
    ["parent", "refreshSeconds", 90], ["child", "refreshSeconds", 90],
    ["parent", "refreshSeconds", 120],
  ]);
});
