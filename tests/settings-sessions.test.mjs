// Two in-process sessions (the #52 subagent shape): each runs the same
// extension factory, so each declares the same rig.json section. The parent's
// handle and listeners must stay live after the child redeclares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { scriptedSession } from "./helpers/session.mjs";
import { rigSettings } from "../shared/settings/index.ts";

const DECL = [{ key: "refreshSeconds", type: "integer", min: 5, max: 3600, default: 60, description: "Refresh" }];

test("a child session's redeclare leaves the parent's handle and listeners live", async (t) => {
  // scriptedSession restores env per session in FIFO order, so the second would
  // put the first's sandbox back; restore the original env last.
  const env = { ...process.env };
  const heard = [];
  const handles = {};
  const extension = (who) => (pi) => {
    const section = rigSettings(getAgentDir()).declare("lane", DECL);
    handles[who] = section;
    const off = section.onChange((key, value) => heard.push([who, key, value]));
    pi.on("session_shutdown", off);
  };
  await scriptedSession(t, { extensions: [extension("parent")] });
  const { session: child } = await scriptedSession(t, { extensions: [extension("child")] });
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  });

  handles.parent.set("refreshSeconds", 30);
  const [menu] = rigSettings(getAgentDir()).sections(); // what /rig edits
  menu.set("refreshSeconds", 90);
  assert.equal(handles.parent.get("refreshSeconds"), 90);
  assert.equal(handles.child.get("refreshSeconds"), 90);

  await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  handles.child.set("refreshSeconds", 120);
  assert.deepEqual(heard, [
    ["parent", "refreshSeconds", 30], ["child", "refreshSeconds", 30],
    ["parent", "refreshSeconds", 90], ["child", "refreshSeconds", 90],
    ["parent", "refreshSeconds", 120],
  ]);
});
