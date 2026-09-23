// The viewer's log source and chat lookup, in plain node (#45).
import "./fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { logLine, logSource, MAX_LINES, MAX_READ } = await import("../extensions/fleet/log.ts");
const { createViewer, findChat, TESTED_PI } = await import("../extensions/fleet/viewer.ts");
const { fleet } = await import("../shared/fleet/index.ts");
const { Container, Text } = await import("@earendil-works/pi-tui");

function tempLog(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rig-viewer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "job.log");
}

test("a log line keeps SGR colours and loses every other control sequence", () => {
  assert.equal(logLine("\x1b[1;31mred\x1b[0m plain"), "\x1b[1;31mred\x1b[0m plain");
  assert.equal(logLine("\x1b[38:5:208mo\x1b[m"), "\x1b[38:5:208mo\x1b[m");
  assert.equal(logLine("a\x1b[2Jb\x1b[1Ac\x1b[?1049hd"), "abcd");
  assert.equal(logLine("\x1b]0;pwned\x07title\x1b]8;;http://x\x1b\\link"), "titlelink");
  assert.equal(logLine("\x9b2Jx\x1bPq\x1b\\y\x1bcz\x07\x08"), "xyz");
  assert.equal(logLine("a\tb"), "a    b");
  assert.equal(logLine("10%\r50%\r100%\r"), "100%", "after a carriage return only the last write shows");
});

test("a log source reads only what was appended, across split lines and characters", (t) => {
  const path = tempLog(t);
  const source = logSource(path);
  assert.equal(source.read(), false, "a missing file reads as empty");
  assert.deepEqual(source.lines(), []);

  writeFileSync(path, "one\ntw");
  assert.equal(source.read(), true);
  assert.deepEqual(source.lines(), ["one", "tw"], "the unfinished line shows");
  assert.equal(source.read(), false, "nothing new");

  const euro = Buffer.from("€");
  appendFileSync(path, Buffer.concat([Buffer.from("o\r\nthree "), euro.subarray(0, 1)]));
  source.read();
  appendFileSync(path, Buffer.concat([euro.subarray(1), Buffer.from("\n\x1b[32mgreen\x1b[0m\x1b[K\n")]));
  source.read();
  assert.deepEqual(source.lines(), ["one", "two", "three €", "\x1b[32mgreen\x1b[0m"]);

  truncateSync(path, 0);
  writeFileSync(path, "fresh\n");
  source.read();
  assert.deepEqual(source.lines(), ["fresh"], "a truncated log starts over");
});

test("a log source keeps the latest lines", (t) => {
  const path = tempLog(t);
  writeFileSync(path, Array.from({ length: MAX_LINES + 5 }, (_, i) => `l${i}`).join("\n") + "\n");
  const source = logSource(path);
  source.read();
  const lines = source.lines();
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines[0], "l5");
  assert.equal(lines.at(-1), `l${MAX_LINES + 4}`);
});

test("the chat lookup needs the tested Pi version and document shape", () => {
  const doc = new Container();
  const chat = new Container();
  doc.addChild(new Container());
  doc.addChild(new Container());
  doc.addChild(chat);
  const tui = { children: [doc, new Container()] };

  assert.deepEqual(findChat(tui, TESTED_PI), { parent: doc, chat });
  assert.equal(findChat(tui, "0.88.0"), undefined, "another Pi version");
  assert.equal(findChat({ children: [] }, TESTED_PI), undefined, "no document");
  assert.equal(findChat({ children: [new Text("x")] }, TESTED_PI), undefined, "first child not a container");
  doc.addChild(new Container());
  assert.equal(findChat(tui, TESTED_PI), undefined, "four children");
  doc.children.splice(2, 2, new Text("chat"));
  assert.equal(findChat(tui, TESTED_PI), undefined, "chat not a container");
});

test("one read takes at most MAX_READ bytes and marks what it skipped", (t) => {
  const path = tempLog(t);
  const source = logSource(path);
  writeFileSync(path, "start\n");
  source.read();
  const line = "x".repeat(999) + "\n"; // 1000 bytes
  const count = Math.ceil(MAX_READ / 1000) + 50;
  appendFileSync(path, line.repeat(count) + "last\n");
  source.read();
  const lines = source.lines();
  assert.match(lines[0], /^… \d+ bytes skipped$/);
  assert.ok(Number(lines[0].match(/\d+/)[0]) >= 50 * 1000, lines[0]);
  assert.equal(lines.at(-1), "last");
  assert.ok(lines.length <= MAX_READ / 1000 + 3, `only the tail was read: ${lines.length} lines`);
});

test("the skip line survives a tail longer than MAX_LINES", (t) => {
  const path = tempLog(t);
  const source = logSource(path);
  writeFileSync(path, "y\n".repeat(MAX_READ)); // 2 MiB of short lines
  source.read();
  const lines = source.lines();
  assert.equal(lines[0], `… ${MAX_READ} bytes skipped`);
  assert.equal(lines.length, MAX_LINES + 1);
});

test("a log that cannot be read shows why once, and reading never throws", (t) => {
  const path = tempLog(t);
  mkdirSync(path); // a directory: EISDIR
  const source = logSource(path);
  assert.equal(source.read(), true);
  assert.match(source.lines().at(-1), /^cannot read the log: .*EISDIR/);
  assert.equal(source.read(), false, "the same error again changes nothing");
  assert.equal(source.lines().length, 1);
});

test("a sequence split across reads never shows as text", (t) => {
  const path = tempLog(t);
  const source = logSource(path);
  writeFileSync(path, "abc\x1b]0;ti");
  source.read();
  assert.deepEqual(source.lines(), ["abc"]);
  appendFileSync(path, "tle\x07def \x1b[3");
  source.read();
  assert.deepEqual(source.lines(), ["abcdef "], "the cut CSI is held back");
  appendFileSync(path, "1mred\x1b[0m\n");
  source.read();
  assert.deepEqual(source.lines(), ["abcdef \x1b[31mred\x1b[0m"]);
});

test("an overlay that fails to open leaves nothing open and no watcher", async (t) => {
  const path = tempLog(t);
  const registry = fleet();
  registry.register({ id: "u1", owner: "unit", kind: "shell", label: "job", activity: () => "", view: { log: path }, stop() {} });
  t.after(() => registry.finish("u1", "completed", "", null));
  const watchers = () => process.getActiveResourcesInfo().filter((r) => r === "StatWatcher").length;
  const ctx = { ui: { theme: { fg: (_c, s) => s }, custom: () => Promise.reject(new Error("no overlay")) } };
  const viewer = createViewer(ctx, () => ({ children: [], requestRender() {} }));
  viewer.open(registry.get("u1"));
  assert.equal(viewer.active(), "u1");
  await new Promise(setImmediate);
  assert.equal(viewer.active(), undefined);
  assert.equal(registry.viewing, undefined);
  assert.equal(watchers(), 0);
});
