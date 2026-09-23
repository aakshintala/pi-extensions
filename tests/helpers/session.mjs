// In-process SDK session whose model replies are scripted with pi-ai's faux provider.
//
//   const { session, faux, cwd, home, agentDir } = await scriptedSession(t, { replies, extensions, tools });
//
//   replies     faux steps: fauxAssistantMessage(...) or (context) => fauxAssistantMessage(...)
//   extensions  extension file paths or inline factories (pi) => {...}; only these load
//   tools       tool allowlist (default: pi's default built-ins)
//   persist     true saves the session as a .jsonl under the temp box, via SessionManager.create;
//               read it at session.sessionManager.getSessionFile() (default: in-memory)
//
// Hermetic: temp cwd, HOME and agent dir, PI_OFFLINE=1, in-memory session and settings,
// no credentials. HOME/PI_CODING_AGENT_DIR/PI_OFFLINE are set on process.env for the
// test's duration, so run one scripted session at a time per file (node:test's default).
// In t.after, like pi on quit: session_shutdown is emitted, the session disposed, then
// env restored and temp dirs removed, so cleanup runs on failure too.
// Credentials and model catalogs live in memory, so the session never writes agent/auth.json
// or agent/models-store.json, even from refreshes that finish after cleanup. An in-process
// child must pass createAgentSession({ modelRuntime: session.modelRuntime, ... }); without
// it Pi builds a file-backed runtime that can recreate those files after the box is gone.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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

// pi-ai's CredentialStore in memory; modify and delete run one at a time per provider.
function memoryCredentials() {
  const creds = new Map();
  const queues = new Map();
  const serial = (id, op) => {
    const run = (queues.get(id) ?? Promise.resolve()).then(op);
    queues.set(id, run.catch(() => {}));
    return run;
  };
  return {
    read: async (id) => structuredClone(creds.get(id)),
    list: async () => [...creds].map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: (id, fn) =>
      serial(id, async () => {
        const next = await fn(structuredClone(creds.get(id)));
        if (next !== undefined) creds.set(id, structuredClone(next));
        return structuredClone(creds.get(id));
      }),
    delete: (id) => serial(id, async () => void creds.delete(id)),
  };
}

export async function scriptedSession(t, { replies = [], extensions = [], tools, persist = false } = {}) {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "pi-rig-session-")));
  const home = join(box, "home");
  const cwd = join(box, "cwd");
  const agentDir = join(box, "agent");
  for (const d of [home, cwd, agentDir]) mkdirSync(d);

  const sealed = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const saved = Object.fromEntries(Object.keys(sealed).map((k) => [k, process.env[k]]));
  Object.assign(process.env, sealed);
  let session;
  t.after(async () => {
    try {
      if (session) {
        if (session.extensionRunner.hasHandlers("session_shutdown")) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
        session.dispose();
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(box, { recursive: true, force: true });
    }
  });

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(replies);
  const modelRuntime = await ModelRuntime.create({
    credentials: memoryCredentials(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensions.filter((e) => typeof e === "string"),
    extensionFactories: extensions.filter((e) => typeof e === "function"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: persist ? SessionManager.create(cwd, join(box, "sessions")) : SessionManager.inMemory(cwd),
    tools,
  }));
  return { session, faux, cwd, home, agentDir };
}
