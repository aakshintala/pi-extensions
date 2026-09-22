// Search-surface proof for extensions/search/index.ts (issue #10).
// Fakes the pi boundary (no pi runtime needed) and drives every behavior
// through the registered `grep`/`find` tool names — never private helpers.
// Also pins the dual-naming resolution: no `ffgrep`/`fffind` registrations.
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/search/index.ts";

function makePi() {
  const tools = new Map();
  return {
    tools,
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
}

let root;
let pi;

before(() => {
  root = mkdtempSync(join(tmpdir(), "search-test-"));
  writeFileSync(join(root, ".gitignore"), "*.log\nbuild/\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\nconst hay = 2;\nconst needle2 = 3;\n");
  writeFileSync(join(root, "src", "b.ts"), "NEEDLE upper\n");
  mkdirSync(join(root, "ignored"), { recursive: true });
  writeFileSync(join(root, "ignored", "x.log"), "needle in ignored log\n");
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "out.js"), "needle in build\n");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "needle in git\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0xff]));
  writeFileSync(join(root, "long.txt"), `needle ${"x".repeat(1000)}\n`);
  mkdirSync(join(root, "many"), { recursive: true });
  for (let i = 0; i < 10; i++) writeFileSync(join(root, "many", `f${i}.txt`), `needle ${i}\n`);

  pi = makePi();
  const returned = factory(pi);
  assert.ok(!(returned instanceof Promise), "factory must be synchronous");
});

const grep = (params) => pi.tools.get("grep").execute("id", params, undefined);
const find = (params) => pi.tools.get("find").execute("id", params, undefined);
const text = (r) => r.content[0].text;

describe("search registration", () => {
  it("registers only grep and find under the standard names", () => {
    assert.deepEqual([...pi.tools.keys()].sort(), ["find", "grep"]);
    assert.ok(!pi.tools.has("ffgrep") && !pi.tools.has("fffind"), "no parallel FFF names");
  });

  it("two factories share no state", async () => {
    const other = makePi();
    factory(other);
    const a = await other.tools.get("grep").execute("id", { pattern: "needle", path: join(root, "src") }, undefined);
    assert.match(a.content[0].text, /a\.ts:1/);
  });
});

describe("grep through the standard name", () => {
  it("finds regex matches as rel:line: text", async () => {
    const out = text(await grep({ pattern: "needle", path: join(root, "src") }));
    assert.match(out, /a\.ts:1: const needle = 1;/);
    assert.match(out, /a\.ts:3: const needle2 = 3;/);
    assert.doesNotMatch(out, /hay/);
  });

  it("literal mode disables regex", async () => {
    const asRegex = text(await grep({ pattern: "ne.dle", path: join(root, "src") }));
    assert.match(asRegex, /a\.ts:1/);
    const asLiteral = text(await grep({ pattern: "ne.dle", literal: true, path: join(root, "src") }));
    assert.match(asLiteral, /No matches/);
  });

  it("ignoreCase folds case", async () => {
    const lower = text(await grep({ pattern: "needle", path: join(root, "src", "b.ts") }));
    assert.match(lower, /No matches/);
    const folded = text(await grep({ pattern: "needle", ignoreCase: true, path: join(root, "src", "b.ts") }));
    assert.match(folded, /b\.ts:1: NEEDLE upper/);
  });

  it("glob filters files", async () => {
    const out = text(await grep({ pattern: "needle", path: root, glob: "*.ts" }));
    assert.match(out, /a\.ts/);
    assert.doesNotMatch(out, /out\.js/);
  });

  it("respects .gitignore and skips .git and binaries", async () => {
    const out = text(await grep({ pattern: "needle", path: root }));
    assert.doesNotMatch(out, /x\.log/);
    assert.doesNotMatch(out, /out\.js/);
    assert.doesNotMatch(out, /HEAD/);
    assert.doesNotMatch(out, /bin\.dat/);
  });

  it("truncates long lines to 500 chars", async () => {
    const out = text(await grep({ pattern: "needle", path: join(root, "long.txt") }));
    const content = out.split("\n")[0].replace(/^.*?:\d+: /, "");
    assert.ok(content.length <= 500, `content too long: ${content.length}`);
  });

  it("context includes neighboring lines", async () => {
    const out = text(await grep({ pattern: "hay", context: 1, path: join(root, "src") }));
    assert.match(out, /a\.ts:1: const needle = 1;/);
    assert.match(out, /a\.ts:2: const hay = 2;/);
    assert.match(out, /a\.ts:3: const needle2 = 3;/);
  });

  it("limit caps matches and says so", async () => {
    const out = text(await grep({ pattern: "needle", limit: 3, path: join(root, "many") }));
    assert.equal(out.split("\n").filter((l) => !l.startsWith("(")).length, 3);
    assert.match(out, /truncated/);
  });

  it("reports bad input as text, never throws", async () => {
    assert.match(text(await grep({ pattern: "([", path: root })), /invalid regex/);
    assert.match(text(await grep({ pattern: "x", path: join(root, "nope") })), /path not found/);
    assert.match(text(await grep({ pattern: "zzz-no-such-string", path: join(root, "src") })), /No matches/);
  });

  it("searches a single file path", async () => {
    const out = text(await grep({ pattern: "hay", path: join(root, "src", "a.ts") }));
    assert.match(out, /a\.ts:2/);
  });
});

describe("find through the standard name", () => {
  it("matches basenames at any depth, sorted", async () => {
    const out = text(await find({ pattern: "*.ts", path: root }));
    assert.deepEqual(
      out.split("\n").filter((l) => l.endsWith(".ts")),
      ["src/a.ts", "src/b.ts"],
    );
  });

  it("matches rooted globs", async () => {
    const out = text(await find({ pattern: "src/*.ts", path: root }));
    assert.match(out, /src\/a\.ts/);
    const deep = text(await find({ pattern: "src/**/*.ts", path: root }));
    assert.match(deep, /src\/a\.ts/);
  });

  it("respects .gitignore and skips .git", async () => {
    const out = text(await find({ pattern: "*", path: root }));
    assert.doesNotMatch(out, /\.log/);
    assert.doesNotMatch(out, /build\//);
    assert.doesNotMatch(out, /\.git\//);
    assert.match(out, /src\/a\.ts/);
  });

  it("limit caps results and says so", async () => {
    const out = text(await find({ pattern: "*.txt", limit: 3, path: join(root, "many") }));
    assert.equal(out.split("\n").filter((l) => !l.startsWith("(")).length, 3);
    assert.match(out, /truncated/);
  });

  it("reports bad input as text, never throws", async () => {
    assert.match(text(await find({ pattern: "x", path: join(root, "nope") })), /path not found/);
    assert.match(text(await find({ pattern: "*.zzz-no-such-ext", path: root })), /No files matching/);
  });
});
