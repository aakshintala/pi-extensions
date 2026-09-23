// Scripted-model sessions for inline-skills: what reaches the model when a prompt
// names skills, once per branch, with skill markup intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, scriptedSession } from "./helpers/session.mjs";

const EXT = new URL("../extensions/inline-skills/index.ts", import.meta.url).pathname;
const SKILLS = new URL("./fixtures/inline-skills/skills", import.meta.url).pathname;

// Each reply records the request it answers: the text of every message sent.
function start(t, turns) {
  const requests = [];
  const replies = Array.from({ length: turns }, () => (context) => {
    requests.push(context.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""))));
    return fauxAssistantMessage(fauxText("ok"));
  });
  // Skills come from a copy in the session's temp cwd, so a test may delete one.
  const skills = (pi) => pi.on("resources_discover", (e) => ({ skillPaths: [join(e.cwd, "skills")] }));
  return scriptedSession(t, { replies, extensions: [EXT, skills] }).then(async (s) => {
    cpSync(SKILLS, join(s.cwd, "skills"), { recursive: true });
    const errors = [];
    await s.session.bindExtensions({ uiContext: { notify: (m, level) => errors.push([level, m]) }, mode: "tui" });
    return { ...s, requests, errors };
  });
}
const skillMessages = (request) => request.filter((m) => m.startsWith("Skills named in the user's message"));

test("a prompt naming skills loads each once per branch; later prompts cost nothing", async (t) => {
  const { session, requests } = await start(t, 4);
  await session.prompt("use /tdd and (/grilling) please, then /tdd again");
  await session.prompt("more /tdd and /nope");
  await session.prompt("plain text with /usr/bin/tdd and /tdd:x");

  const [first, second, third] = requests;
  assert.ok(first.includes("use /tdd and (/grilling) please, then /tdd again"), "the prompt is sent unchanged");
  const [loaded] = skillMessages(first);
  assert.equal(skillMessages(first).length, 1);
  assert.match(loaded, /Skill `tdd` \(.*tdd\/SKILL\.md\)[\s\S]*Body of tdd\.[\s\S]*Skill `grilling`/);
  assert.doesNotMatch(loaded, /name: tdd/, "frontmatter is stripped");
  assert.equal(skillMessages(second).length, 1, "tdd is not loaded again");
  assert.equal(skillMessages(third).length, 1, "no skill token, no new message");

  // Navigating back before the load restores the branch's loaded set: tdd loads again.
  const firstUser = session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
  await session.navigateTree(firstUser.parentId ?? firstUser.id);
  await session.prompt("fresh /tdd");
  assert.equal(skillMessages(requests[3]).length, 1);
  assert.match(skillMessages(requests[3])[0], /Body of tdd\./);
});

test("skill markup reaches the model intact, inside a fence it cannot close", async (t) => {
  const { session, requests } = await start(t, 1);
  await session.prompt("/markup go");
  const [message] = skillMessages(requests[0]);
  const body = readFileSync(join(SKILLS, "markup", "SKILL.md"), "utf8").split("---\n")[2].trim();
  assert.ok(message.includes(`\`\`\`\`\`markdown\n${body}\n\`\`\`\`\``), message);
});

test("an unreadable skill file is reported and the prompt still runs", async (t) => {
  const { session, requests, errors, cwd } = await start(t, 2);
  rmSync(join(cwd, "skills", "tdd", "SKILL.md"));
  await session.prompt("use /tdd");
  assert.deepEqual(skillMessages(requests[0]), []);
  assert.deepEqual(errors, [["error", "inline-skills: could not read tdd"]]);
  // Not marked loaded, so a later prompt tries again once the file is back.
  cpSync(join(SKILLS, "tdd", "SKILL.md"), join(cwd, "skills", "tdd", "SKILL.md"));
  await session.prompt("use /tdd");
  assert.equal(skillMessages(requests[1]).length, 1);
});
