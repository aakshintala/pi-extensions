// In-process SDK session whose model replies are scripted with pi-ai's faux provider.
//
//   const { session, faux, cwd, agentDir } = await scriptedSession(t, { replies, extensions, tools });
//
//   replies     faux steps: fauxAssistantMessage(...) or (context) => fauxAssistantMessage(...)
//   extensions  extension file paths to load (only these; no discovery)
//   tools       tool allowlist (default: pi's default built-ins)
//
// Hermetic: temp cwd + agentDir, in-memory session and settings, no credentials.
// The session is disposed and temp dirs removed in t.after, so cleanup runs on failure too.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

export async function scriptedSession(t, { replies = [], extensions = [], tools } = {}) {
  const box = mkdtempSync(join(tmpdir(), "pi-rig-session-"));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const cwd = join(box, "cwd");
  const agentDir = join(box, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(replies);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensions,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools,
  });
  t.after(() => session.dispose());
  return { session, faux, cwd, agentDir };
}
