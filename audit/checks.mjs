// Pure functions over an audit snapshot. Shared by audit/index.mjs and
// tests/audit.test.mjs. No I/O, no dependencies.

// ponytail: char/4 token estimate, not a real tokenizer. Upgrade if a
// ceiling ever binds within 2x of the estimate.
const tokens = (chars) => Math.ceil(chars / 4);

export function toolTokens(t) {
  return tokens(
    String(t.description ?? "").length +
      JSON.stringify(t.parameters ?? {}).length +
      (t.promptGuidelines ?? []).join("\n").length,
  );
}

// Extracts the <available_skills> names pi renders into the system prompt.
export function parseSkillsFromPrompt(prompt) {
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(prompt ?? "")?.[1] ?? "";
  return [...block.matchAll(/<skill>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
}

// Short owner label for a tool/command source path: npm package name,
// else the directory under ~/.pi/agent, else the raw path.
export function sourceLabel(path) {
  if (typeof path !== "string") return "?";
  if (path.startsWith("<builtin")) return "builtin";
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
  if (nm) return nm[1];
  const local = /\.pi\/agent\/(?:local|git\/[^/]+\/[^/]+|extensions)\/((?:@[^/]+\/)?[^/.]+)/.exec(path);
  if (local) return local[1];
  return path;
}

export function report(snap) {
  const active = new Set(snap.activeTools ?? []);
  const tools = (snap.allTools ?? [])
    .filter((t) => active.has(t.name))
    .map((t) => ({ name: t.name, tokens: toolTokens(t), source: sourceLabel(t.sourceInfo?.path) }))
    .sort((a, b) => b.tokens - a.tokens);
  const systemPrompt = tokens(String(snap.systemPrompt ?? "").length);
  const toolTotal = tools.reduce((n, t) => n + t.tokens, 0);
  const keys = (snap.models ?? []).map((m) => `${m.provider}/${m.id}`);
  return {
    totalTokens: systemPrompt + toolTotal,
    systemPromptTokens: systemPrompt,
    toolTokens: toolTotal,
    tools,
    commands: (snap.commands ?? []).length,
    skills: parseSkillsFromPrompt(snap.systemPrompt).length,
    models: keys.length,
    duplicateModels: [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))],
  };
}

// CI gate: the package loads, shuts down cleanly, and stays under the
// prompt ceiling. Returns failure strings; empty means pass.
export function gate(snap, lifecycle, budgets) {
  const failures = [];
  for (const k of ["activeTools", "allTools", "commands", "systemPrompt"]) {
    if (snap[k] === undefined) failures.push(`snapshot missing ${k} (pi API change?)`);
  }
  if (lifecycle.timedOut) failures.push("pi timed out");
  if (!lifecycle.shutdownObserved) failures.push("session_shutdown never fired");
  const { totalTokens, duplicateModels } = report(snap);
  if (totalTokens > budgets.maxPromptTokens) {
    failures.push(`prompt budget exceeded: ${totalTokens} > ${budgets.maxPromptTokens} tokens`);
  }
  if (duplicateModels.length > 0) failures.push(`duplicate models: ${duplicateModels.join(", ")}`);
  // Every non-builtin active tool needs a per-tool ceiling in budgets.tools.
  const toolBudgets = budgets.tools ?? {};
  for (const t of report(snap).tools) {
    const max = toolBudgets[t.name];
    if (t.source === "builtin") continue;
    if (max === undefined) failures.push(`tool ${t.name} has no budget in budgets.json tools`);
    else if (t.tokens > max) failures.push(`tool ${t.name} over budget: ${t.tokens} > ${max} tokens`);
  }
  for (const name of Object.keys(toolBudgets)) {
    if (!(snap.activeTools ?? []).includes(name)) failures.push(`budgeted tool ${name} is not active`);
  }
  return failures;
}
