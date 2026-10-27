import { COMMANDS, COMMAND_NAMES } from "./commands.ts";
import type { Ctx } from "./cmd-types.ts";
import { parse, tokenize } from "./parser.ts";
import type { Word } from "./parser.ts";
import type { ExecResult, OutLine, ShellAction, ShellState } from "./types.ts";
import { createShell, getNode, normalizePath, sortedEntries, splitParent, writeFile } from "./vfs.ts";

export { createShell } from "./vfs.ts";
export { displayPath } from "./vfs.ts";
export type { ShellState, ExecResult, OutLine, ShellAction } from "./types.ts";
export { assessCommand } from "./risk.ts";
export type { Risk, Category, Dread } from "./risk.ts";
export { COMMAND_NAMES } from "./commands.ts";

const MAX_HISTORY = 200;

function expandVars(sh: ShellState, value: string): string {
  return value
    .replace(/\$\{?HOME\}?/g, sh.home)
    .replace(/\$\{?USER\}?/g, sh.user)
    .replace(/\$\{?PWD\}?/g, sh.cwd)
    .replace(/\$\?/g, String(sh.lastExit));
}

function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}$`);
}

/** Expand a single `*`/`?` pattern against the virtual filesystem. */
function expandGlob(sh: ShellState, word: string): string[] {
  if (!/[*?]/.test(word)) return [word];
  // `/*` stays literal so that `rm` can stage its permission-denied pantomime instead of wiping the fake root.
  if (word === "/*") return [word];
  const slash = word.lastIndexOf("/");
  const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
  const pattern = slash >= 0 ? word.slice(slash + 1) : word;
  const dirAbs = normalizePath(sh.cwd, dirPart || ".", sh.home);
  const node = getNode(sh.fs, dirAbs);
  if (!node || node.type !== "dir") return [word];
  const re = globToRegExp(pattern);
  const matches = sortedEntries(node)
    .map(([name]) => name)
    .filter((name) => re.test(name) && (!name.startsWith(".") || pattern.startsWith(".")));
  return matches.length ? matches.map((m) => dirPart + m) : [word];
}

function expandWord(sh: ShellState, w: Word): string[] {
  let value = w.literal ? w.value : expandVars(sh, w.value);
  if (!w.quoted && (value === "~" || value.startsWith("~/"))) {
    value = sh.home + value.slice(1);
  }
  return w.quoted || w.literal ? [value] : expandGlob(sh, value);
}

/** After `rm -rf ~` the working directory may no longer exist; walk up to the nearest survivor. */
function repairCwd(sh: ShellState): void {
  let cwd = sh.cwd;
  while (cwd !== "/" && getNode(sh.fs, cwd)?.type !== "dir") cwd = splitParent(cwd).parent;
  sh.cwd = cwd;
}

/**
 * Execute one command line against the simulated shell. Mutates `sh` in place
 * (cwd, filesystem, git, history) and returns what to print plus any
 * side-effects the UI must act on (ghost level, séance, exorcism...).
 */
export function executeCommand(sh: ShellState, raw: string): ExecResult {
  const line = raw.trim();
  const result: ExecResult = { lines: [], exitCode: 0, clear: false, actions: [] };
  if (!line) return result;

  if (sh.history[sh.history.length - 1] !== line) sh.history.push(line);
  if (sh.history.length > MAX_HISTORY) sh.history.splice(0, sh.history.length - MAX_HISTORY);
  sh.commandCount++;

  const chain = parse(tokenize(line));
  let last = 0;
  const push = (kind: OutLine["kind"], texts?: string[]) => {
    for (const text of texts ?? []) result.lines.push({ kind, text });
  };

  for (const entry of chain) {
    if (entry.joiner === "&&" && last !== 0) continue;
    if (entry.joiner === "||" && last === 0) continue;

    let stdin: string[] | null = null;
    let code = 0;
    for (let i = 0; i < entry.pipeline.length; i++) {
      const cmd = entry.pipeline[i];
      let argv = cmd.argv.flatMap((w) => expandWord(sh, w));
      let sudo = false;
      if (argv[0] === "sudo") {
        sudo = true;
        argv = argv.slice(1).filter((a, idx) => !(idx === 0 && a.startsWith("-")));
        push("out", [`[sudo] password for ${sh.user}: `]);
      }
      const name = argv[0];
      if (!name) {
        code = 0;
        continue;
      }
      const fn = COMMANDS[name];
      const ctx: Ctx = { sh, stdin, sudo };
      const out = fn ? fn(ctx, argv.slice(1)) : { err: [`bash: ${name}: command not found`], code: 127 };
      code = out.code;
      if (out.clear) result.clear = true;
      if (out.actions) result.actions.push(...(out.actions as ShellAction[]));

      const isLast = i === entry.pipeline.length - 1;
      push("err", out.err);
      if (isLast) {
        if (cmd.redirect) {
          const target = expandWord(sh, cmd.redirect.target)[0];
          const abs = normalizePath(sh.cwd, target, sh.home);
          const text = (out.out ?? []).join("\n") + ((out.out ?? []).length ? "\n" : "");
          if (!writeFile(sh.fs, abs, text, cmd.redirect.mode === ">>")) {
            push("err", [`bash: ${target}: No such file or directory`]);
            code = 1;
          }
        } else push("out", out.out);
      } else {
        stdin = out.out ?? [];
      }
    }
    last = code;
  }

  repairCwd(sh);
  result.exitCode = last;
  sh.lastExit = last;
  sh.errorStreak = last === 0 ? 0 : sh.errorStreak + 1;
  return result;
}

/** Restore the filesystem and git state to the seed; optionally forget history too. */
export function exorcise(sh: ShellState, forgetHistory: boolean): void {
  const fresh = createShell();
  const history = forgetHistory ? [] : sh.history;
  Object.assign(sh, fresh, { history, commandCount: sh.commandCount });
}

export interface Completion {
  line: string;
  options: string[];
}

/** Bash-style tab completion for commands and virtual paths. */
export function complete(sh: ShellState, line: string): Completion {
  const m = line.match(/^(.*?)(\S*)$/s);
  const before = m?.[1] ?? "";
  const word = m?.[2] ?? "";
  const isFirst = before.trim() === "" && !/\s/.test(before);

  let candidates: string[];
  let prefix = word;
  let dirPrefix = "";

  if (isFirst) {
    candidates = COMMAND_NAMES.filter((c) => c.startsWith(word));
  } else {
    const slash = word.lastIndexOf("/");
    dirPrefix = slash >= 0 ? word.slice(0, slash + 1) : "";
    prefix = slash >= 0 ? word.slice(slash + 1) : word;
    const dirAbs = normalizePath(sh.cwd, dirPrefix || ".", sh.home);
    const node = getNode(sh.fs, dirAbs);
    candidates =
      node && node.type === "dir"
        ? sortedEntries(node)
            .filter(([n]) => n.startsWith(prefix) && (prefix.startsWith(".") || !n.startsWith(".")))
            .map(([n, v]) => (v.type === "dir" ? `${n}/` : n))
        : [];
  }

  if (!candidates.length) return { line, options: [] };
  if (candidates.length === 1) {
    const only = candidates[0];
    const suffix = only.endsWith("/") ? "" : " ";
    return { line: before + dirPrefix + only + suffix, options: [] };
  }
  let common = candidates[0];
  for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
  return { line: before + dirPrefix + (common.length > prefix.length ? common : prefix), options: candidates };
}
