#!/usr/bin/env node
/**
 * haunt: the real-shell companion to Echoes of the Terminal.
 *
 *   haunt git push --force          run a real command, then hear the ghost's verdict
 *   haunt whisper 1 "gti status"    comment on a command that already ran (shell hooks)
 *   haunt init bash | zsh           print a hook that haunts every command you type
 *   haunt lore                      hear a ghost story
 *
 * Needs Node 22.18+ (it runs TypeScript directly). The ghost speaks through a
 * local Ollama (loopback only) and falls back to the scripted ghost when no
 * model answers. Only the command text is ever sent, never its output.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DEFAULT_OLLAMA_MODEL } from "../src/lib/ghost/models.ts";
import { OllamaBackend, DEFAULT_OLLAMA_URL, isLoopbackUrl, listOllamaModels, modelIsPulled, pickOllamaModel } from "../src/lib/ghost/ollama.ts";
import { getPersona } from "../src/lib/ghost/personas.ts";
import { shouldHaunt } from "../src/lib/ghost/prompt.ts";
import { scriptedLore } from "../src/lib/ghost/scripted.ts";
import type { GhostBackend, GhostContext, GhostLevel } from "../src/lib/ghost/types.ts";
import { generateWhisper } from "../src/lib/ghost/whisper.ts";
import { assessCommand } from "../src/lib/shell/risk.ts";

const GHOST = "\x1b[3;35m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

export interface Options {
  model: string;
  url: string;
  level: GhostLevel;
  persona: string | null;
  scripted: boolean;
  odds: number;
  rest: string[];
}

const HELP = `haunt: a ghost for your real shell

usage
  haunt <command...>            run the command for real, then the ghost comments
  haunt whisper <exit> <cmd>    comment on a command that already ran
  haunt init <bash|zsh>         print a shell hook (eval "$(haunt init bash)")
  haunt lore                    tell a ghost story

options
  --model <name>     Ollama model (default ${DEFAULT_OLLAMA_MODEL}, env HAUNT_MODEL)
  --url <url>        Ollama address, loopback only (default ${DEFAULT_OLLAMA_URL}, env HAUNT_OLLAMA_URL)
  --level <l>        whisper | haunt | possess (default haunt, env HAUNT_LEVEL)
  --seance <id>      channel a spirit: cobol, perl, flash, ie6 ... (env HAUNT_SEANCE)
  --odds <0-1>       chance of commenting on a harmless command (hooks use 0.5, env HAUNT_ODDS)
  --scripted         skip the model, use the hand-written ghost
`;

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const o: Options = {
    model: env.HAUNT_MODEL ?? DEFAULT_OLLAMA_MODEL,
    url: env.HAUNT_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    level: (["whisper", "haunt", "possess"].includes(env.HAUNT_LEVEL ?? "") ? env.HAUNT_LEVEL : "haunt") as GhostLevel,
    persona: env.HAUNT_SEANCE ?? null,
    scripted: false,
    odds: env.HAUNT_ODDS !== undefined ? Number(env.HAUNT_ODDS) : 1,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--") {
      o.rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--model") o.model = next();
    else if (a === "--url") o.url = next();
    else if (a === "--level") o.level = next() as GhostLevel;
    else if (a === "--seance") o.persona = next();
    else if (a === "--odds") o.odds = Number(next());
    else if (a === "--scripted") o.scripted = true;
    else if (o.rest.length === 0 && a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.rest.push(a);
  }
  if (!["whisper", "haunt", "possess"].includes(o.level)) throw new Error("--level must be whisper, haunt or possess");
  if (!Number.isFinite(o.odds)) o.odds = 1;
  if (o.persona && !getPersona(o.persona)) throw new Error(`no such spirit '${o.persona}'`);
  return o;
}

/** Strip obvious credentials before the command text goes anywhere, even to a local model. */
export function redact(command: string): string {
  return command
    .replace(/((?:token|password|passwd|secret|api[-_]?key|apikey)\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/(--(?:token|password|secret|api-key)\s+)\S+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1[redacted]")
    .replace(/(:\/\/[^:/\s]+:)[^@\s]+@/g, "$1[redacted]@");
}

export function shellQuote(args: string[]): string {
  if (args.length === 1) return args[0];
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

// ---------------------------------------------------------------- state

const stateFile = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "haunt", "recent.json");

interface State {
  history: string[];
  errorStreak: number;
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as State;
    return { history: Array.isArray(s.history) ? s.history.slice(-8) : [], errorStreak: s.errorStreak | 0 };
  } catch {
    return { history: [], errorStreak: 0 };
  }
}

function saveState(s: State): void {
  try {
    const f = stateFile();
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, JSON.stringify({ history: s.history.slice(-8), errorStreak: s.errorStreak }));
  } catch {
    /* the ghost forgets; no harm done */
  }
}

function gitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 800 }).toString().trim() || null;
  } catch {
    return null;
  }
}

function prettyCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd === home ? "~" : cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
}

// ---------------------------------------------------------------- the ghost

async function pickBackend(o: Options): Promise<GhostBackend | null> {
  if (o.scripted) return null;
  if (!isLoopbackUrl(o.url) && process.env.HAUNT_ALLOW_REMOTE !== "1") {
    throw new Error(`refusing ${o.url}: haunt only talks to Ollama on this machine. Set HAUNT_ALLOW_REMOTE=1 to override.`);
  }
  const models = await listOllamaModels(o.url, AbortSignal.timeout(500));
  if (!models.length) return null;
  const model = modelIsPulled(o.model, models) ? o.model : (pickOllamaModel(models) ?? o.model);
  return new OllamaBackend(model, o.url);
}

export async function whisperAbout(command: string, exitCode: number, o: Options, out: NodeJS.WritableStream = process.stdout): Promise<void> {
  const state = loadState();
  const prior = state.history;
  const safe = redact(command);
  const risk = assessCommand(safe);
  state.errorStreak = exitCode === 0 ? 0 : state.errorStreak + 1;
  state.history = [...prior, safe].slice(-8);
  saveState(state);

  const roll = Math.random();
  const dull = risk.dread === 0 && exitCode === 0;
  if (!shouldHaunt(o.level, risk, exitCode, safe) || (dull && roll > o.odds)) return;

  const now = new Date();
  const ctx: GhostContext = {
    command: safe,
    exitCode,
    cwd: prettyCwd(),
    branch: gitBranch(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    history: prior,
    risk,
    errorStreak: state.errorStreak,
    level: o.level,
    persona: o.persona,
    user: userInfo().username,
  };

  const backend = await pickBackend(o);
  const tty = (out as NodeJS.WriteStream).isTTY === true;
  let written = 0;
  out.write(tty ? `\n${GHOST}~ ` : "~ ");
  const result = await generateWhisper(ctx, {
    backend,
    charDelayMs: tty ? 18 : 0,
    firstTokenTimeoutMs: 6000,
    onUpdate: (text) => {
      if (text.length > written) {
        out.write(text.slice(written));
        written = text.length;
      }
    },
  });
  if (result.text.length > written) out.write(result.text.slice(written));
  out.write(tty ? `${RESET}\n\n` : "\n");
}

// ---------------------------------------------------------------- hooks

const BASH_HOOK = `# haunt: possess every command you type (bash)
__haunt_prompt() {
  local status=$?
  local n
  n=$(HISTTIMEFORMAT= history 1 | awk '{print $1}')
  if [ -n "$n" ] && [ "$n" != "$__haunt_n" ]; then
    __haunt_n="$n"
    local cmd
    cmd=$(HISTTIMEFORMAT= history 1 | sed -E 's/^ *[0-9]+ +//')
    haunt whisper "$status" "$cmd" --odds "\${HAUNT_ODDS:-0.5}" 2>/dev/null
  fi
  return $status
}
PROMPT_COMMAND="__haunt_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
`;

const ZSH_HOOK = `# haunt: possess every command you type (zsh)
__haunt_preexec() { __haunt_cmd="$1" }
__haunt_precmd() {
  local status=$?
  if [ -n "$__haunt_cmd" ]; then
    haunt whisper "$status" "$__haunt_cmd" --odds "\${HAUNT_ODDS:-0.5}" 2>/dev/null
    __haunt_cmd=
  fi
  return $status
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __haunt_preexec
add-zsh-hook precmd __haunt_precmd
`;

// ---------------------------------------------------------------- main

function run(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1)));
  });
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const o = parseArgs(argv);
  const [first, ...tail] = o.rest;

  if (first === "init") {
    const shell = tail[0] ?? (process.env.SHELL ?? "").split("/").pop();
    if (shell === "bash") process.stdout.write(BASH_HOOK);
    else if (shell === "zsh") process.stdout.write(ZSH_HOOK);
    else {
      process.stderr.write("haunt init: choose bash or zsh\n");
      return 2;
    }
    return 0;
  }

  if (first === "lore") {
    process.stdout.write(`${scriptedLore()}\n`);
    return 0;
  }

  if (first === "whisper") {
    const code = Number(tail[0]);
    const command = tail.slice(1).join(" ");
    if (!Number.isInteger(code) || !command.trim()) {
      process.stderr.write("usage: haunt whisper <exit-code> <command...>\n");
      return 2;
    }
    await whisperAbout(command, code, o);
    return 0;
  }

  if (o.rest.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = shellQuote(o.rest);
  const code = await run(command);
  await whisperAbout(command, code, o);
  return code;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${DIM}haunt: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
      process.exit(2);
    },
  );
}
