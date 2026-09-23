// Scripted-model sessions over the fixture repo: grep and find go through FFF (spec #35).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, scriptedSession } from "./helpers/session.mjs";
import { makeRepo, spyFFF } from "./fixtures/search/setup.mjs";
import { searchExtension } from "../extensions/search/index.ts";

// One session over a fresh fixture repo; run(calls) makes the faux model call each tool in turn
// and returns the tool result texts.
async function searchSession(t, { load = spyFFF().load, home = false } = {}) {
  let api;
  const { session, faux, cwd } = await scriptedSession(t, {
    extensions: [
      (pi) => {
        api = pi;
        pi.on("session_start", (_e, ctx) => {
          makeRepo(ctx.cwd);
          if (home) process.env.HOME = ctx.cwd; // restored by the session helper
        });
        searchExtension(load)(pi);
      },
    ],
    tools: ["grep", "find"],
  });
  await session.bindExtensions({}); // emits session_start, as Pi's modes do
  const run = async (calls) => {
    faux.setResponses([
      ...calls.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const before = session.messages.length;
    await session.prompt("search");
    return session.messages.slice(before).filter((m) => m.role === "toolResult").map((m) => m.content[0].text);
  };
  return { session, api, run, cwd };
}

const sorted = (s) => s.split("\n").sort().join("\n");

test("grep: literal, regex, smart case, constraints, context, limit, .gitignore", async (t) => {
  const spy = spyFFF();
  const { run } = await searchSession(t, { load: spy.load });
  const r = await run([
    ["grep", { pattern: "foo.bar()", literal: true }],
    ["grep", { pattern: "fo+\\.bar\\(" }],
    ["grep", { pattern: "token" }],
    ["grep", { pattern: "Token" }],
    ["grep", { pattern: "token", ignoreCase: false }],
    ["grep", { pattern: "TOKEN", ignoreCase: true, path: "src" }],
    ["grep", { pattern: "token", glob: "*.js" }],
    ["grep", { pattern: "token", path: "lib/util.js" }],
    ["grep", { pattern: "TODO", context: 1 }],
    ["grep", { pattern: "item", limit: 2 }],
    ["grep", { pattern: "export const", glob: "src/**/*.ts" }],
    ["grep", { pattern: "nothing-here" }],
  ]);
  assert.equal(r[0], "src/auth/config.ts:4: foo.bar()");
  assert.equal(sorted(r[1]), "src/auth/config.ts:4: foo.bar()\nsrc/auth/config.ts:5: fooo.bar()");
  // Smart case: lowercase matches any case; build/out.js is gitignored.
  assert.equal(
    sorted(r[2]),
    ["lib/util.js:1: token here", "src/app.spec.ts:1: test(\"token\", () => {});", "src/auth/config.ts:1: export const Token = 1;", "src/auth/config.ts:2: const token = 2;"].join("\n"),
  );
  assert.equal(r[3], "src/auth/config.ts:1: export const Token = 1;");
  assert.equal(sorted(r[4]), ["lib/util.js:1: token here", "src/app.spec.ts:1: test(\"token\", () => {});", "src/auth/config.ts:2: const token = 2;"].join("\n"));
  assert.equal(sorted(r[5]), ["app.spec.ts:1: test(\"token\", () => {});", "auth/config.ts:1: export const Token = 1;", "auth/config.ts:2: const token = 2;"].join("\n"));
  assert.equal(r[6], "lib/util.js:1: token here");
  assert.equal(r[7], "util.js:1: token here");
  assert.equal(r[8], "src/auth/config.ts-2- const token = 2;\nsrc/auth/config.ts:3: // TODO fix\nsrc/auth/config.ts-4- foo.bar()");
  assert.equal(r[9], "notes.md:1: item 1\nnotes.md:2: item 2\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]");
  assert.equal(r[10], "src/auth/config.ts:1: export const Token = 1;");
  assert.equal(r[11], "No matches found");
  assert.equal(spy.calls.filter(([m]) => m === "grep").length, 12);
});

test("grep: an invalid regex is an error, as with the built-in", async (t) => {
  const { session, run } = await searchSession(t);
  await run([["grep", { pattern: "foo(" }]]);
  assert.equal(session.messages.findLast((m) => m.role === "toolResult").isError, true);
});

test("find: glob, fuzzy, ranking by git changes, limit", async (t) => {
  const spy = spyFFF();
  const { run } = await searchSession(t, { load: spy.load });
  const r = await run([
    ["find", { pattern: "*.js" }],
    ["find", { pattern: "src/**/*.ts" }],
    ["find", { pattern: "*.ts", path: "src" }],
    ["find", { pattern: "auth conf" }],
    ["find", { pattern: "handler" }],
    ["find", { pattern: "**/handler.ts" }],
    ["find", { pattern: "*.ts", limit: 1 }],
    ["find", { pattern: "*.nope" }],
  ]);
  assert.equal(r[0], "lib/util.js");
  assert.equal(sorted(r[1]), "src/app.spec.ts\nsrc/auth.ts\nsrc/auth/config.ts");
  assert.equal(sorted(r[2]), "app.spec.ts\nauth.ts\nauth/config.ts");
  assert.equal(r[3].split("\n")[0], "src/auth/config.ts");
  // b/handler.ts has uncommitted changes, so it ranks above the identical a/handler.ts.
  assert.equal(r[4], "b/handler.ts\na/handler.ts");
  assert.equal(r[5], "b/handler.ts\na/handler.ts");
  assert.match(r[6], /^\S+\.ts\n\n\[1 results limit reached\. Use limit=2 for more, or refine pattern\]$/);
  assert.equal(r[7], "No files found matching pattern");
  assert.deepEqual(spy.calls.map(([m]) => m), ["glob", "glob", "glob", "fileSearch", "fileSearch", "glob", "glob", "glob"]);
});

test("a file written during the session appears in results", async (t) => {
  const spy = spyFFF();
  const { cwd, run } = await searchSession(t, { load: spy.load });
  assert.deepEqual(await run([["grep", { pattern: "fresh_symbol" }]]), ["No matches found"]);
  // Synchronise on FFF's watcher applying the change, not on time.
  const indexed = new Promise((done) => spy.finders[0].watch("new.ts", done));
  writeFileSync(join(cwd, "new.ts"), "const fresh_symbol = 1;\n");
  await indexed;
  assert.deepEqual(await run([["grep", { pattern: "fresh_symbol" }], ["find", { pattern: "new" }]]), [
    "new.ts:1: const fresh_symbol = 1;",
    "new.ts",
  ]);
});

test("a search before the index is ready waits for it", async (t) => {
  let waiting, release;
  const asked = new Promise((r) => (waiting = r));
  const gate = new Promise((r) => (release = r));
  const spy = spyFFF({ waitForScan: async (real, ms) => (waiting(ms), await gate, real(ms)) });
  const { run } = await searchSession(t, { load: spy.load });
  const result = run([["grep", { pattern: "login" }]]);
  assert.equal(await asked, 5000);
  assert.deepEqual(spy.calls, []); // still waiting: nothing searched yet
  release();
  assert.deepEqual(await result, ["src/auth.ts:1: export function login() {}"]);
  assert.equal(spy.calls.length, 1);
});

test("a search whose index is not ready in 5 s falls back for that call", async (t) => {
  let late = true;
  const spy = spyFFF({ waitForScan: async (real, ms) => (late ? { ok: true, value: false } : real(ms)) });
  const { run } = await searchSession(t, { load: spy.load });
  assert.deepEqual(await run([["grep", { pattern: "login" }]]), ["src/auth.ts:1: export function login() {}"]);
  assert.deepEqual(spy.calls, []); // served by Pi's built-in grep
  late = false;
  await run([["grep", { pattern: "login" }]]);
  assert.deepEqual(spy.calls.map(([m]) => m), ["grep"]);
});

test("falls back to the built-ins when the FFF binding is unavailable", async (t) => {
  const spy = spyFFF();
  spy.FileFinder.isAvailable = () => false;
  const { run } = await searchSession(t, { load: spy.load });
  const r = await run([["grep", { pattern: "login" }], ["find", { pattern: "*.js" }]]);
  assert.deepEqual(r, ["src/auth.ts:1: export function login() {}", "lib/util.js"]);
  assert.equal(spy.created, 0);
});

test("falls back to the built-ins when the binding fails to load", async (t) => {
  const { run } = await searchSession(t, { load: async () => { throw new Error("no native library"); } });
  assert.deepEqual(await run([["grep", { pattern: "login" }]]), ["src/auth.ts:1: export function login() {}"]);
});

test("a session in $HOME never indexes it", async (t) => {
  const spy = spyFFF();
  const { run } = await searchSession(t, { load: spy.load, home: true });
  assert.deepEqual(await run([["find", { pattern: "*.js" }]]), ["lib/util.js"]);
  assert.equal(spy.created, 0);
});

test("results come from the FFF finder, not the file system", async (t) => {
  // A stand-in finder at the binding boundary reports a file that does not exist on disk.
  const item = { relativePath: "ghost.ts", fileName: "ghost.ts", gitStatus: "clean", totalFrecencyScore: 0 };
  const fake = {
    isDestroyed: false,
    destroy() { this.isDestroyed = true; },
    waitForScan: async () => ({ ok: true, value: true }),
    grep: () => ({ ok: true, value: { items: [{ ...item, lineNumber: 7, lineContent: "only in FFF" }], nextCursor: null } }),
    glob: () => ({ ok: true, value: { items: [item], totalMatched: 1 } }),
    fileSearch: () => ({ ok: true, value: { items: [item], scores: [{ total: 1 }], totalMatched: 1 } }),
  };
  const load = async () => ({ isAvailable: () => true, create: () => ({ ok: true, value: fake }) });
  const { session, run } = await searchSession(t, { load });
  const r = await run([["grep", { pattern: "x" }], ["find", { pattern: "*.ts" }], ["find", { pattern: "ghost" }]]);
  assert.deepEqual(r, ["ghost.ts:7: only in FFF", "ghost.ts", "ghost.ts"]);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await new Promise(setImmediate);
  assert.equal(fake.isDestroyed, true);
});

test("registers only grep and find, sourced from the rig", async (t) => {
  let api;
  await scriptedSession(t, {
    extensions: [new URL("../extensions/search/index.ts", import.meta.url).pathname, (pi) => void (api = pi)],
  });
  const tools = api.getAllTools();
  for (const name of ["grep", "find"]) {
    assert.match(tools.find((x) => x.name === name).sourceInfo.path, /extensions\/search\/index\.ts$/);
  }
  assert.deepEqual(tools.filter((x) => /ffgrep|fffind|multi_grep/.test(x.name)), []);
  assert.deepEqual(api.getCommands().filter((c) => c.name.startsWith("fff")), []);
});

test("shutdown destroys the index, and a second shutdown is a no-op", async (t) => {
  const spy = spyFFF();
  const { session, run } = await searchSession(t, { load: spy.load });
  await run([["find", { pattern: "*.js" }]]);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await new Promise(setImmediate);
  assert.equal(spy.finders[0].isDestroyed, true); // the helper emits shutdown again in t.after
});
