// The job guards of #49 that need no job state: the blocking-sleep check and the prompt shape.

const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "select", "case", "esac", "in", "{", "}", "!", "time", "function"]);
/** Reserved words after which the next word is a command again. */
const LEADS = new Set(["if", "then", "else", "elif", "do", "while", "until", "{", "!", "time"]);
/** Commands that run the command in their arguments, with how many operands come first. */
const WRAPPERS: Record<string, number> = { command: 0, builtin: 0, exec: 0, env: 0, nice: 0, nohup: 0, timeout: 1 };
/** Wrapper options that take the next word as their value. */
const OPTION_ARGS: Record<string, RegExp> = { nice: /^-n$/, timeout: /^-[sk]$/, exec: /^-a$/, env: /^-[uCS]$/ };

/**
 * Whether `command` runs `sleep` in the foreground outside a `while` or `until` loop.
 * Reads the shell's structure: quotes, comments, heredoc bodies and redirections are not
 * commands, `sleep N &` does not block, a function body does not run where it is defined,
 * and `command`/`exec`/`env`/`nice`/`nohup`/`timeout` wrappers, `/bin/sleep`, `\sleep`
 * and `$(...)` or backtick substitutions are seen through.
 * ponytail: `bash -c "..."` and `eval` are not seen.
 */
export function blockingSleep(src: string): boolean {
  const blocks: string[] = []; // open while/until/for/select/function/{, innermost last
  const heredocs: string[] = [];
  let atCommand = true;
  let wrapper: { name: string; operands: number; skipNext: boolean } | undefined;
  let fnName = false; // the last command word may be a function name: `f() {`
  let fnBody = false; // `f()` or `function f` seen: the next `{` opens a body
  let fnKeyword = false; // `function` seen: a name follows
  let sleeping = false; // a sleep command whose end has not been seen yet
  let i = 0;
  const polling = () => blocks.some((b) => b === "while" || b === "until" || b === "function");
  const ends = (op: string) => {
    if (sleeping && op !== "&") return true;
    sleeping = false;
    atCommand = true;
    wrapper = undefined;
    return false;
  };
  while (i < src.length) {
    const rest = src.slice(i);
    const c = src[i];
    if (c === "\n") {
      if (ends(";")) return true;
      i++;
      for (const tag of heredocs.splice(0)) {
        const lines = src.slice(i).split("\n");
        const n = lines.findIndex((l) => l.replace(/^\t+/, "") === tag);
        i = n < 0 ? src.length : i + lines.slice(0, n + 1).join("\n").length + 1;
      }
      continue;
    }
    if (c === " " || c === "\t" || rest.startsWith("\\\n")) {
      i += c === "\\" ? 2 : 1;
      continue;
    }
    if (c === "#") {
      i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      continue;
    }
    if (fnName && /^\(\s*\)/.test(rest)) {
      // `name()`: a function definition, not a call.
      i += /^\(\s*\)/.exec(rest)![0].length;
      fnName = false;
      fnBody = true;
      sleeping = false;
      atCommand = true;
      continue;
    }
    fnName = false;
    const redirect = /^(&>>?|\d*(<<<|<<-?|>>|>\||<>|[<>])&?-?)/.exec(rest);
    if (redirect) {
      i += redirect[0].length;
      const word = readWord(src, i);
      i = word.end;
      if (word.subs.some(blockingSleep) && !polling()) return true;
      if (/^\d*<<-?$/.test(redirect[0])) heredocs.push(word.text);
      continue;
    }
    const op = /^(&&|\|\||;;&?|;&|\|&|[;&|()])/.exec(rest);
    if (op) {
      if (ends(op[0])) return true;
      i += op[0].length;
      continue;
    }
    const word = readWord(src, i);
    i = word.end;
    if (word.subs.some(blockingSleep) && !polling()) return true;
    if (!atCommand) continue;
    const w = word.text;
    if (/^[A-Za-z_]\w*=/.test(w)) continue; // an assignment before the command
    if (wrapper) {
      if (wrapper.skipNext) {
        wrapper.skipNext = false;
        continue;
      }
      if (w.startsWith("-")) {
        if (wrapper.name === "command" && /^-[vV]/.test(w)) atCommand = false; // looks the command up, runs nothing
        wrapper.skipNext = OPTION_ARGS[wrapper.name]?.test(w) ?? false;
        continue;
      }
      if (wrapper.operands > 0) {
        wrapper.operands--;
        continue;
      }
      wrapper = undefined;
    } else if (RESERVED.has(w) && !word.quoted) {
      if (["while", "until", "for", "select"].includes(w)) blocks.push(w);
      if (w === "{") blocks.push(fnBody ? "function" : "{");
      if (w === "done" || w === "}") blocks.pop();
      fnBody = false;
      fnKeyword = w === "function";
      atCommand = LEADS.has(w) || fnKeyword;
      continue;
    }
    if (fnKeyword) {
      // The name after `function`.
      fnKeyword = false;
      fnBody = true;
      continue;
    }
    const name = w.replace(/^.*\//, "");
    if (name in WRAPPERS) {
      wrapper = { name, operands: WRAPPERS[name], skipNext: false };
      continue;
    }
    atCommand = false;
    fnName = true;
    if (name === "sleep" && !polling()) sleeping = true;
  }
  return sleeping;
}

/** One shell word from `start` with its quotes and backslashes removed, its command substitutions, and where it ends. */
function readWord(src: string, start: number) {
  let i = start;
  let text = "";
  let quoted = false;
  const subs: string[] = [];
  /** Reads a `$(...)` or backtick substitution at `j` and returns where it ends. */
  const sub = (j: number) => {
    if (src[j] === "`") {
      const end = src.indexOf("`", j + 1);
      subs.push(src.slice(j + 1, end < 0 ? src.length : end));
      return end < 0 ? src.length : end + 1;
    }
    let depth = 0;
    let k = j + 1;
    do {
      if (src[k] === "(") depth++;
      else if (src[k] === ")") depth--;
      k++;
    } while (k < src.length && depth > 0);
    subs.push(src.slice(j + 2, k - 1));
    return k;
  };
  while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
    const c = src[i];
    if (c === "\\") {
      text += src[i + 1] ?? "";
      quoted = true;
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      text += src.slice(i + 1, end < 0 ? src.length : end);
      quoted = true;
      i = end < 0 ? src.length : end + 1;
    } else if (c === '"') {
      quoted = true;
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") (text += src[j + 1] ?? ""), (j += 2);
        else if (src[j] === "`" || src.startsWith("$(", j)) j = sub(j);
        else text += src[j++];
      }
      i = j + 1;
    } else if (c === "`" || src.startsWith("$(", i)) {
      i = sub(i);
    } else {
      text += c;
      i++;
    }
  }
  return { text, quoted, subs, end: i };
}

/**
 * The unfinished line a job's output stopped on, if it asks for input: `[y/N]`, `(yes/no)`,
 * `Password:`, `Enter passphrase for key:`, an inquirer-style `? Pick one`, or a line ending
 * in `? ` or `> `.
 */
export const PROMPT = /\[y\/n\]|\(y\/n\)|\[yes\/no\]|\(yes\/no\)|^\s*\? \S|\b(password|passphrase|username|login)\b[^:\n]*: ?$|[?>] $/i;
