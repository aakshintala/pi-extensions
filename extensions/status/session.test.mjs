// Scripted-model session: the faux model calls get_quotas against a fake loopback feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "../../tests/helpers/session.mjs";
import "../../tests/fixtures/tool-display/pi-tui.mjs"; // before the extension, which draws with pi-tui
const { default: status } = await import("./index.ts");

const FEED = {
  providers: [
    { id: "claude", tier: "Max", status: "healthy", quotas: [{ label: "Session", percentRemaining: 78, status: "healthy" }] },
    { id: "codex", tier: "PLUS", status: "healthy", quotas: [{ label: "Weekly", percentRemaining: 24, status: "healthy" }] },
  ],
};

test("get_quotas in a scripted session, with and without a provider filter", async (t) => {
  const server = createServer((_req, res) => res.end(JSON.stringify(FEED)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

  const call = (args) => [
    fauxAssistantMessage(fauxToolCall("get_quotas", args), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("ok")),
  ];
  const { session } = await scriptedSession(t, {
    replies: [...call({}), ...call({ provider: "codex" })],
    extensions: [
      (pi) => {
        // The helper's agent dir exists only now; point the status section at the fake feed.
        writeFileSync(join(getAgentDir(), "rig.json"), JSON.stringify({ status: { quotaPort: server.address().port } }));
        status(pi);
      },
    ],
    tools: ["get_quotas"],
  });

  await session.prompt("quotas?");
  await session.prompt("codex quota?");
  const results = session.messages.filter((m) => m.role === "toolResult");
  assert.deepEqual(
    results.map((m) => [m.toolName, m.isError, m.content[0].text]),
    [
      ["get_quotas", false, "claude (Max): session 78%\ncodex (PLUS): weekly 24%"],
      ["get_quotas", false, "codex (PLUS): weekly 24%"],
    ],
  );
});
