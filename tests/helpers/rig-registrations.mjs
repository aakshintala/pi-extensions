// Loads every extensions/*/index.ts through the real DefaultResourceLoader, so a test
// can walk what the rig actually registers (tools, message/entry renderers, event
// handlers) instead of hand-listing renderers that drift out of date. Sandboxed the
// same way tests/helpers/session.mjs boxes a session, but skips ModelRuntime and
// session creation: registration alone needs none of that, and registerTool() is a
// no-op against the loader's own actions until a real AgentSession completes them.
//
// Import tests/fixtures/tool-display/pi-tui.mjs before calling loadRig(): several
// extensions import @earendil-works/pi-tui, which plain Node cannot resolve on its own.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const EXT_DIR = fileURLToPath(new URL("../../extensions/", import.meta.url));

/** Every extensions/<name>/index.ts the rig ships: the same set package.json's
 * "./extensions/*\/index.ts" glob picks up. */
export const allExtensionPaths = () =>
  readdirSync(EXT_DIR)
    .map((name) => join(EXT_DIR, name, "index.ts"))
    .filter((p) => existsSync(p));

/** Loads every rig extension for real; returns its Extension[] (each with .tools,
 * .messageRenderers, .entryRenderers, .handlers) plus any load errors. `t.after`
 * restores the sandboxed env and removes the box. */
export async function loadRig(t) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-registrations-")));
  const home = join(box, "home");
  const cwd = join(box, "cwd");
  const agentDir = join(box, "agent");
  for (const d of [home, cwd, agentDir]) mkdirSync(d);

  const sealed = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const saved = Object.fromEntries(Object.keys(sealed).map((k) => [k, process.env[k]]));
  Object.assign(process.env, sealed);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(box, { recursive: true, force: true });
  });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: allExtensionPaths(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { extensions, errors } = resourceLoader.getExtensions();
  return { extensions, errors, cwd, agentDir };
}
