// Tool display (#55, #56) in a scripted session: the rig's read keeps Pi's execution,
// renders in the shared style, and replaces the built-in once, also after /reload;
// a saved transcript groups the same way as the live session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "./fixtures/tool-display/pi-tui.mjs";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";

const { default: toolDisplay } = await import("../extensions/tool-display/index.ts");
const plain = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

test("read runs as Pi's read, renders in the shared style, and is registered once", async (t) => {
  initTheme("dark", false);
  const { session, cwd } = await scriptedSession(t, {
    replies: [fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
    extensions: [toolDisplay],
    tools: ["read", "edit", "write", "ls"],
  });
  writeFileSync(join(cwd, "a.txt"), "one\ntwo");
  await session.prompt("read a.txt");
  const call = session.messages.find((m) => m.role === "assistant").content[0];
  const result = session.messages.find((m) => m.role === "toolResult");
  assert.deepEqual([result.isError, result.content[0].text], [false, "one\ntwo"]);

  const render = () => {
    const c = new ToolExecutionComponent("read", call.id, call.arguments, {}, session.getToolDefinition("read"), { requestRender() {} }, cwd);
    c.updateResult({ content: result.content, details: result.details, isError: result.isError });
    c.setExpanded(true); // collapsed, a lone call is a one-line group summary
    return c.render(80).map(plain).filter(Boolean);
  };
  const names = () => session.getAllTools().map((t) => t.name).filter((n) => ["read", "edit", "write"].includes(n)).sort();
  for (const when of ["start", "after reload"]) {
    assert.deepEqual(render(), [" ⏺ Read(a.txt)", "   ⎿  Read 2 lines", "      one", "      two"], when);
    assert.deepEqual(names(), ["edit", "read", "write"], when);
    if (when === "start") await session.reload();
  }
});

test("the rig adds no active tools to Pi's defaults", async (t) => {
  const { session } = await scriptedSession(t, { extensions: [toolDisplay] });
  assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]);
});

test("a saved transcript groups the same way as the live session", async (t) => {
  initTheme("dark", false);
  const read = (path) => fauxToolCall("read", { path });
  const { session, cwd } = await scriptedSession(t, {
    replies: [
      fauxAssistantMessage([read("a.txt"), read("missing.txt"), fauxText("and"), read("a.txt"), fauxToolCall("ls", {}), read("a.txt")], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("ok")),
    ],
    extensions: [toolDisplay],
    tools: ["read", "ls"],
  });
  writeFileSync(join(cwd, "a.txt"), "one\ntwo");
  await session.prompt("go");
  const results = new Map(session.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const calls = session.messages.find((m) => m.role === "assistant").content.filter((b) => b.type === "toolCall");
  // Pi's chat builds one component per call, in order, and gives it the saved result.
  const transcript = () =>
    calls
      .map((b) => {
        const c = new ToolExecutionComponent(b.name, b.id, b.arguments, {}, session.getToolDefinition(b.name), { requestRender() {} }, cwd);
        const r = results.get(b.id);
        c.updateResult({ content: r.content, details: r.details, isError: r.isError });
        return c;
      })
      .flatMap((c) => c.render(80).map(plain));

  const live = transcript();
  assert.deepEqual(live.slice(0, 5), ["", " ⏺ Read 2 files · 1 failed", "", " ⏺ Read(missing.txt)", `   ⎿  Error: ENOENT: no such file or directory, access 'missing.txt'`]);
  assert.deepEqual(live.slice(5, 7), ["", " ⏺ Read 1 file"]);
  assert.deepEqual(live.slice(-2), ["", " ⏺ Read 1 file"]); // ls, not grouped, splits the run
  // As on /resume: groups are forgotten, then registered again from the saved branch.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
  assert.equal(transcript()[1], " ⏺ Read(a.txt)");
  await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  assert.deepEqual(transcript(), live);
});

test("rig tools count in a group summary with their own verbs", async (t) => {
  initTheme("dark", false);
  const extensions = await Promise.all(["todo", "status", "search"].map(async (n) => (await import(`../extensions/${n}/index.ts`)).default));
  const { session, cwd } = await scriptedSession(t, { extensions: [toolDisplay, ...extensions] });
  const { ToolGroups } = await import("../shared/tool-display/index.ts");
  const groups = new ToolGroups();
  t.after(() => groups.reset());
  const calls = [
    ["grep", { pattern: "a" }], ["grep", { pattern: "b" }], ["find", { pattern: "*.ts" }],
    ["todo_write", { todos: [] }], ["get_quotas", {}], ["todo_write", { todos: [] }],
  ].map(([name, args], i) => ({ type: "toolCall", id: `r${i}`, name, arguments: args }));
  groups.track({ role: "assistant", content: calls });
  for (const c of calls) groups.settle(c.id, false, { content: [] });
  const components = calls.map((c) => new ToolExecutionComponent(c.name, c.id, c.arguments, {}, session.getToolDefinition(c.name), { requestRender() {} }, cwd));
  assert.deepEqual(components.flatMap((c) => c.render(80)).map(plain), ["", " ⏺ Searched 2 patterns, found files, updated todos, checked quotas"]);
});

test("a search pattern is drawn as one clean line", async (t) => {
  initTheme("dark", false);
  const { default: search } = await import("../extensions/search/index.ts");
  const { session, cwd } = await scriptedSession(t, { extensions: [search] });
  const c = new ToolExecutionComponent("grep", "g1", { pattern: "a\nb\x1b]0;title\x07c" }, {}, session.getToolDefinition("grep"), { requestRender() {} }, cwd);
  assert.deepEqual(c.render(80).map(plain), ["", " ⏺ Grep(a bc)"]);
});

test("an aborted turn reads the same live and after the session is reopened", async (t) => {
  initTheme("dark", false);
  const { default: wait } = await import("./fixtures/tool-display/wait.ts");
  const call = (name, args) => fauxToolCall(name, args);
  const { session, cwd } = await scriptedSession(t, {
    replies: [fauxAssistantMessage([call("read", { path: "a.txt" }), call("wait", { file: "x" }), call("wait", { file: "y" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
    // Esc once the read is done and both waits are running.
    extensions: [toolDisplay, wait, (pi) => pi.on("tool_execution_end", (e, ctx) => e.toolName === "read" && ctx.abort())],
    tools: ["read", "wait"],
  });
  writeFileSync(join(cwd, "a.txt"), "one");
  await session.prompt("go");
  const assistant = session.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"));
  const results = new Map(session.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const transcript = () => {
    const components = assistant.content.map((b) => {
      const c = new ToolExecutionComponent(b.name, b.id, b.arguments, {}, session.getToolDefinition(b.name), { requestRender() {} }, cwd);
      const r = results.get(b.id);
      if (r) c.updateResult({ content: r.content, details: r.details, isError: r.isError });
      return c;
    });
    return components.flatMap((c) => c.render(80)).map(plain);
  };
  const live = transcript();
  assert.deepEqual(live, ["", " ⏺ Read 1 file, waited on 2 files · 2 cancelled"]);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
  await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  assert.deepEqual(transcript(), live);
});

test("Esc during a shell command reads as cancelled, live and after the session is reopened", async (t) => {
  initTheme("dark", false);
  const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const { toolRenderers } = await import("../shared/tool-display/index.ts");
  // Pi's own bash, drawn in the shared style with a summary, as the rig's bash will be.
  const bash = (pi) => {
    pi.registerTool({
      ...createBashToolDefinition(process.cwd()),
      ...toolRenderers({ title: "Bash", arg: (a) => a.command, result: () => ({ summary: "ran", body: [] }), summary: { verb: "ran", one: "shell command" } }),
    });
    pi.on("tool_execution_update", (_e, ctx) => ctx.abort()); // Esc once the command has printed
  };
  const { session, cwd } = await scriptedSession(t, {
    replies: [fauxAssistantMessage(fauxToolCall("bash", { command: "echo started; sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))],
    extensions: [toolDisplay, bash],
    tools: ["bash"],
  });
  await session.prompt("go");
  const call = session.messages.find((m) => m.role === "assistant").content[0];
  const result = session.messages.find((m) => m.role === "toolResult");
  assert.match(result.content[0].text, /Command aborted$/);
  const transcript = () => {
    const c = new ToolExecutionComponent("bash", call.id, call.arguments, {}, session.getToolDefinition("bash"), { requestRender() {} }, cwd);
    c.updateResult({ content: result.content, details: result.details, isError: result.isError });
    return c.render(80).map(plain);
  };
  const live = transcript();
  assert.deepEqual(live, ["", " ⏺ Ran 1 shell command · 1 cancelled"]);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
  await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  assert.deepEqual(transcript(), live);
});
