// Pure budget checks over an audit snapshot. Shared by audit/index.mjs and
// tests/audit.test.mjs. Every check throws on violation, returns a short
// summary string on success. No I/O, no dependencies.

// ponytail: char/4 token estimate, not a real tokenizer. Upgrade if a
// ceiling ever binds within 2x of the estimate.
export function estimatePromptTokens(snapshot) {
  const prompt = typeof snapshot.systemPrompt === "string" ? snapshot.systemPrompt : "";
  const active = new Set(snapshot.activeTools ?? []);
  const defs = (snapshot.allTools ?? []).filter((t) => active.has(t.name));
  const chars =
    prompt.length +
    defs.reduce(
      (n, t) =>
        n +
        String(t.description ?? "").length +
        JSON.stringify(t.parameters ?? {}).length +
        (t.promptGuidelines ?? []).join("\n").length,
      0,
    );
  return Math.ceil(chars / 4);
}

function names(list, key = "name") {
  return (list ?? []).map((e) => e?.[key]).filter((n) => typeof n === "string");
}

// Extracts the <available_skills> inventory pi renders into the system
// prompt (see formatSkillsForPrompt upstream). The probe keeps an inline
// copy; this one is the testable canonical version.
export function parseSkillsFromPrompt(prompt) {
  const unescape = (s) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(prompt ?? "")?.[1] ?? "";
  const skills = [];
  for (const m of block.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const body = m[1];
    const field = (tag) => {
      const v = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(body)?.[1];
      return v === undefined ? undefined : unescape(v);
    };
    skills.push({ name: field("name"), description: field("description"), location: field("location") });
  }
  return skills;
}

export function checkTools(snapshot, baseline) {
  if (!Array.isArray(snapshot.activeTools) || !Array.isArray(snapshot.allTools)) {
    throw new Error("tools section missing from snapshot (pi API change?)");
  }
  const active = [...snapshot.activeTools].sort();
  const want = [...(baseline.activeTools ?? [])].sort();
  if (JSON.stringify(active) !== JSON.stringify(want)) {
    throw new Error(
      `active tools changed: got [${active}] want [${want}]`,
    );
  }
  const known = new Set([...names(baseline.allTools), ...(baseline.activeTools ?? [])]);;
  const unknown = names(snapshot.allTools).filter((n) => !known.has(n));
  if (unknown.length > 0) throw new Error(`unknown tools: [${unknown}]`);
  return `tools ok (${active.length} active)`;
}

export function checkSkills(snapshot, baseline) {
  if (!Array.isArray(snapshot.skills)) {
    throw new Error("skills section missing from snapshot (pi API change?)");
  }
  const got = names(snapshot.skills).sort();
  const want = names(baseline.skills ?? []).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const added = got.filter((n) => !want.includes(n));
    const removed = want.filter((n) => !got.includes(n));
    throw new Error(
      `skills changed: added [${added}] removed [${removed}]`,
    );
  }
  return `skills ok (${got.length})`;
}

export function checkCommands(snapshot, baseline) {
  if (!Array.isArray(snapshot.commands)) {
    throw new Error("commands section missing from snapshot (pi API change?)");
  }
  const got = names(snapshot.commands).sort();
  const want = names(baseline.commands).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const added = got.filter((n) => !want.includes(n));
    const removed = want.filter((n) => !got.includes(n));
    throw new Error(
      `commands changed: added [${added}] removed [${removed}]`,
    );
  }
  return `commands ok (${got.length})`;
}

export function checkPromptBudget(snapshot, budgets) {
  const tokens = estimatePromptTokens(snapshot);
  if (tokens > budgets.maxPromptTokens) {
    throw new Error(`prompt budget exceeded: ${tokens} > ${budgets.maxPromptTokens} tokens`);
  }
  return `prompt ok (${tokens} <= ${budgets.maxPromptTokens} tokens)`;
}

export function checkDuplicates(snapshot) {
  if (!Array.isArray(snapshot.models)) {
    throw new Error("models section missing from snapshot (pi API change?)");
  }
  const seen = new Map();
  const dupes = [];
  for (const m of snapshot.models) {
    const key = `${m?.provider}/${m?.id}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) dupes.push(key);
  }
  if (dupes.length > 0) throw new Error(`duplicate provider-model pairs: [${dupes}]`);
  return `models ok (${snapshot.models.length}, no duplicates)`;
}

// Informational only: records intercom presence but never fails, so the
// audit is stable whether ambient intercom peers exist or not.
export function checkIntercom(snapshot) {
  const active = snapshot.activeTools ?? [];
  return `intercom ${active.includes("intercom") ? "on" : "off"} (informational)`;
}

export function checkUpstream(snapshot, repoRoot) {
  const paths = [
    ...(snapshot.allTools ?? []).map((t) => t?.sourceInfo?.path),
    ...(snapshot.commands ?? []).map((c) => c?.sourceInfo?.path),
    ...(snapshot.skills ?? []).map((s) => s?.location ?? s?.filePath),
  ].filter((p) => typeof p === "string");
  const bad = paths.filter(
    (p) => p === `${repoRoot}/upstream` || p.startsWith(`${repoRoot}/upstream/`) || p.includes("/upstream/"),
  );
  if (bad.length > 0) throw new Error(`upstream paths loaded as Pi resources: [${[...new Set(bad)]}]`);
  return "upstream ok (no upstream paths loaded)";
}

export function checkVersion(snapshot, budgets) {
  if (snapshot.piVersion !== budgets.piVersion) {
    throw new Error(`pi version ${snapshot.piVersion} != pinned ${budgets.piVersion}`);
  }
  return `pi ${snapshot.piVersion} ok`;
}

const CHECKS = {
  version: checkVersion,
  tools: checkTools,
  commands: checkCommands,
  skills: checkSkills,
  promptBudget: checkPromptBudget,
  duplicates: checkDuplicates,
  intercom: checkIntercom,
  upstream: checkUpstream,
};

// Run every check, collecting failures instead of stopping at the first.
export function runAll(snapshot, baseline, budgets, repoRoot) {
  const results = {};
  const failures = [];
  const args = { version: [budgets], tools: [baseline], commands: [baseline], skills: [baseline], promptBudget: [budgets], duplicates: [], intercom: [], upstream: [repoRoot] };
  for (const [name, fn] of Object.entries(CHECKS)) {
    try {
      results[name] = { ok: true, detail: fn(snapshot, ...(args[name] ?? [])) };
    } catch (e) {
      results[name] = { ok: false, detail: String(e?.message ?? e) };
      failures.push(name);
    }
  }
  return { results, failures };
}
