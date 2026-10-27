/**
 * TerminalSession: binds the simulated shell and the ghost to an xterm.js
 * Terminal. It is plain TypeScript (no React) and owns line editing, command
 * execution, the typewriter that renders whispers, and the "presence" meter.
 *
 * Colours are ANSI palette indexes only, so switching the phosphor theme
 * recolours text that is already on screen.
 */

import type { Terminal } from "@xterm/xterm";
import { generateWhisper } from "../ghost/whisper.ts";
import { getPersona } from "../ghost/personas.ts";
import { shouldHaunt } from "../ghost/prompt.ts";
import { scriptedLore } from "../ghost/scripted.ts";
import type { GhostBackend, GhostContext, GhostLevel, WhisperResult } from "../ghost/types.ts";
import { assessCommand, complete, createShell, displayPath, executeCommand, exorcise } from "../shell/index.ts";
import type { ShellState } from "../shell/index.ts";

const RESET = "\x1b[0m";
const GHOST = "\x1b[3;35m";
const DIM = "\x1b[90m";
const ERR = "\x1b[31m";

const GLITCH_GLYPHS = "#%&@$?!/\\|<>";
const BUILTIN_SILENT = new Set(["ghost", "seance", "exorcise", "help"]);
const IDLE_FIRST_MS = 55_000;
const IDLE_NEXT_MS = 120_000;

export interface SessionSnapshot {
  presence: number;
  whispering: boolean;
  busy: boolean;
  level: GhostLevel;
  ghostOn: boolean;
  persona: string | null;
  last: LastWhisper | null;
  commands: number;
}

export interface LastWhisper {
  source: WhisperResult["source"];
  fellBack: boolean;
  ttftMs: number | null;
  durationMs: number;
  chars: number;
  error?: string;
}

export interface SessionOptions {
  term: Terminal;
  getBackend: () => GhostBackend | null;
  onChange: (snapshot: SessionSnapshot) => void;
  reducedMotion: boolean;
  initialLevel?: GhostLevel;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class TerminalSession {
  readonly shell: ShellState = createShell();
  private term: Terminal;
  private opts: SessionOptions;
  private disposables: { dispose(): void }[] = [];

  private buffer = "";
  private cursor = 0;
  private promptLen = 0;
  private histIdx = -1;
  private draft = "";

  private busy = false;
  private whispering = false;
  private hasten = false;
  private booting = false;
  /** Keys typed while the ghost is busy; replayed once the prompt returns, like real type-ahead. */
  private pending: string[] = [];
  private abort: AbortController | null = null;
  private disposed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private level: GhostLevel;
  private ghostOn = true;
  private persona: string | null = null;
  private presence = 0;
  private last: LastWhisper | null = null;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.term = opts.term;
    this.level = opts.initialLevel ?? "haunt";
    const lateNight = new Date().getHours() < 5;
    this.presence = lateNight ? 20 : 4;
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.disposables.push(this.term.onData((d) => this.onData(d)));
    this.busy = true;
    this.booting = true;
    this.emit();
    await this.boot();
    this.busy = false;
    this.booting = false;
    this.hasten = false;
    if (this.disposed) return;
    this.prompt();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  focus(): void {
    this.term.focus();
  }

  // ------------------------------------------------------------ public controls

  setLevel(level: GhostLevel): void {
    this.level = level;
    this.emit();
  }

  setGhostOn(on: boolean): void {
    this.ghostOn = on;
    this.emit();
  }

  setPersona(id: string | null): void {
    this.persona = id;
    this.emit();
  }

  /** Type a command as if the visitor had, then run it. Used by the example chips. */
  async runCommand(text: string): Promise<void> {
    if (this.busy || this.disposed) return;
    this.touch();
    this.buffer = "";
    this.cursor = 0;
    this.redraw(0);
    for (const ch of text) {
      this.buffer += ch;
      this.cursor = this.buffer.length;
      this.redraw(this.cursor - 1);
      if (!this.opts.reducedMotion) await sleep(14);
    }
    await this.submit();
    this.term.focus();
  }

  // ------------------------------------------------------------ output helpers

  private write(s: string): void {
    this.term.write(s);
  }

  private emit(): void {
    this.opts.onChange({
      presence: Math.round(this.presence),
      whispering: this.whispering,
      busy: this.busy,
      level: this.level,
      ghostOn: this.ghostOn,
      persona: this.persona,
      last: this.last,
      commands: this.shell.commandCount,
    });
  }

  private promptText(): { text: string; visible: number } {
    const sh = this.shell;
    const host = this.presence >= 85 ? "it-sees-you" : sh.host;
    const cwd = displayPath(sh.cwd, sh.home);
    const inRepo = sh.cwd === `${sh.home}/haunted-project` || sh.cwd.startsWith(`${sh.home}/haunted-project/`);
    const branch = inRepo ? ` (${sh.git.branch})` : "";
    const plain = `${sh.user}@${host}:${cwd}${branch}$ `;
    const text = `\x1b[1;32m${sh.user}@${host}${RESET}:\x1b[34m${cwd}${RESET}${inRepo ? `\x1b[33m${branch}${RESET}` : ""}$ `;
    return { text, visible: plain.length };
  }

  private prompt(): void {
    const p = this.promptText();
    this.promptLen = p.visible;
    this.write(RESET + p.text + this.buffer);
    this.fixWrapEdge();
    this.cursor = this.buffer.length;
    this.touch();
  }

  /** When the line ends exactly at the right margin, force the wrap like bash does so row maths stays exact. */
  private fixWrapEdge(): void {
    const total = this.promptLen + this.buffer.length;
    if (total > 0 && total % this.term.cols === 0) this.write(" \r");
  }

  /** Repaint prompt + buffer, then park the cursor. `prevCursor` is where it was before the edit. */
  private redraw(prevCursor: number): void {
    const cols = this.term.cols;
    const up = Math.floor((this.promptLen + prevCursor) / cols);
    this.write(`${up > 0 ? `\x1b[${up}A` : ""}\r\x1b[J${RESET}${this.promptText().text}${this.buffer}`);
    this.fixWrapEdge();
    if (this.cursor < this.buffer.length) {
      const total = this.promptLen + this.buffer.length;
      const endRow = Math.floor(total / cols);
      const targetRow = Math.floor((this.promptLen + this.cursor) / cols);
      const targetCol = (this.promptLen + this.cursor) % cols;
      const rowsUp = endRow - targetRow;
      this.write(`${rowsUp > 0 ? `\x1b[${rowsUp}A` : ""}\x1b[${targetCol + 1}G`);
    }
  }

  // ------------------------------------------------------------ boot

  private async boot(): Promise<void> {
    const lines = [
      `${DIM}ECHOES BIOS v0.31  (c) 1987 The Dead${RESET}`,
      `${DIM}Memory test: 640K ......... ok${RESET}`,
      `${DIM}Mounting /crypt ........... ok${RESET}`,
      `${DIM}Reading graveyard.sys ..... 3 bad sectors${RESET}`,
      `${DIM}Ghost process (pid 666) ... dormant${RESET}`,
      "",
      "Echoes of the Terminal. Type \x1b[1mhelp\x1b[0m, or try something you shouldn't.",
      `${DIM}This shell is simulated. Nothing here touches your real machine.${RESET}`,
      "",
    ];
    for (const l of lines) {
      if (this.disposed) break;
      this.write(l + "\r\n");
      if (!this.hasten && !this.opts.reducedMotion) await sleep(l ? 150 : 60);
    }
  }

  // ------------------------------------------------------------ input

  private onData(d: string): void {
    if (this.disposed) return;
    if (this.busy) {
      if (d === "\x03") this.abort?.abort();
      else {
        this.hasten = true;
        if (!this.booting) this.pending.push(d);
      }
      return;
    }
    this.touch();
    const prev = this.cursor;
    switch (d) {
      case "\r":
        void this.submit();
        return;
      case "\x7f":
      case "\b":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          this.redraw(prev);
        }
        return;
      case "\x1b[3~":
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.redraw(prev);
        }
        return;
      case "\x1b[D":
        if (this.cursor > 0) this.moveTo(this.cursor - 1);
        return;
      case "\x1b[C":
        if (this.cursor < this.buffer.length) this.moveTo(this.cursor + 1);
        return;
      case "\x1b[H":
      case "\x1bOH":
      case "\x01":
        this.moveTo(0);
        return;
      case "\x1b[F":
      case "\x1bOF":
      case "\x05":
        this.moveTo(this.buffer.length);
        return;
      case "\x1b[A":
        this.history(-1);
        return;
      case "\x1b[B":
        this.history(1);
        return;
      case "\x03":
        this.write(`${DIM}^C${RESET}\r\n`);
        this.buffer = "";
        this.cursor = 0;
        this.histIdx = -1;
        this.prompt();
        return;
      case "\x0c":
        this.write("\x1b[2J\x1b[3J\x1b[H");
        this.redraw(0);
        return;
      case "\x15":
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        this.redraw(prev);
        return;
      case "\x0b":
        this.buffer = this.buffer.slice(0, this.cursor);
        this.redraw(prev);
        return;
      case "\x17": {
        const before = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
        this.buffer = before + this.buffer.slice(this.cursor);
        this.cursor = before.length;
        this.redraw(prev);
        return;
      }
      case "\t":
        this.tab();
        return;
      default:
    }
    if (d.startsWith("\x1b")) return; // unhandled escape sequence
    const submit = /[\r\n]/.test(d);
    const text = d.split(/[\r\n]/)[0].replace(/[\x00-\x1f\x7f]/g, "");
    if (text) {
      this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
      this.cursor += text.length;
      const atEnd = this.cursor === this.buffer.length;
      const total = this.promptLen + this.buffer.length;
      if (atEnd && text.length === 1 && total % this.term.cols !== 0) this.write(text);
      else this.redraw(prev);
    }
    if (submit) void this.submit();
  }

  private moveTo(index: number): void {
    const prev = this.cursor;
    this.cursor = index;
    this.redraw(prev);
  }

  private history(dir: -1 | 1): void {
    const hist = this.shell.history;
    if (!hist.length) return;
    const prev = this.cursor;
    if (this.histIdx === -1) {
      if (dir === 1) return;
      this.draft = this.buffer;
      this.histIdx = hist.length;
    }
    this.histIdx = clamp(this.histIdx + dir, 0, hist.length);
    this.buffer = this.histIdx === hist.length ? this.draft : hist[this.histIdx];
    if (this.histIdx === hist.length) this.histIdx = -1;
    this.cursor = this.buffer.length;
    this.redraw(prev);
  }

  private tab(): void {
    if (this.cursor !== this.buffer.length) return;
    const c = complete(this.shell, this.buffer);
    if (c.line !== this.buffer) {
      const prev = this.cursor;
      this.buffer = c.line;
      this.cursor = this.buffer.length;
      this.redraw(prev);
    } else if (c.options.length > 1) {
      this.write(`\r\n${DIM}${c.options.join("  ")}${RESET}\r\n`);
      this.prompt();
    }
  }

  // ------------------------------------------------------------ execution

  private async submit(): Promise<void> {
    const line = this.buffer;
    this.write("\r\n");
    this.buffer = "";
    this.cursor = 0;
    this.histIdx = -1;
    if (!line.trim()) {
      this.prompt();
      return;
    }
    this.busy = true;
    this.hasten = false;
    this.abort = new AbortController();
    this.emit();
    try {
      await this.execute(line);
    } catch (err) {
      this.write(`${ERR}echoes: ${err instanceof Error ? err.message : String(err)}${RESET}\r\n`);
    } finally {
      this.busy = false;
      this.whispering = false;
      this.abort = null;
      this.hasten = false;
      if (!this.disposed) {
        this.prompt();
        this.emit();
        this.replayPending();
      }
    }
  }

  private replayPending(): void {
    const queued = this.pending;
    this.pending = [];
    for (const d of queued) this.onData(d);
  }

  private async execute(line: string): Promise<void> {
    const sh = this.shell;
    const result = executeCommand(sh, line);
    if (result.clear) this.write("\x1b[2J\x1b[3J\x1b[H");
    for (const l of result.lines) {
      const text = l.text.replace(/\r?\n/g, "\r\n");
      this.write(l.kind === "err" ? `${ERR}${text}${RESET}\r\n` : `${text}\r\n`);
    }

    let spoken: string | null = null;
    for (const a of result.actions) {
      switch (a.type) {
        case "ghost-level":
          this.level = a.level;
          break;
        case "ghost-power":
          this.ghostOn = a.on;
          break;
        case "seance":
          this.persona = a.persona;
          if (a.persona) spoken = getPersona(a.persona)?.greeting ?? null;
          break;
        case "exorcise":
          exorcise(sh, a.history);
          this.persona = null;
          this.presence = 0;
          break;
        case "lore":
          spoken = scriptedLore();
          break;
        case "exit":
          break;
      }
    }

    const risk = assessCommand(line);
    const hour = new Date().getHours();
    const bump = risk.dread * 11 + (result.exitCode !== 0 ? 4 : 0) + (hour < 5 ? 2 : 0);
    this.presence = clamp(this.presence + (bump > 0 ? bump : -5), 0, 100);
    this.emit();

    if (spoken) {
      await this.speakStatic(spoken);
      return;
    }
    const first = line.trim().split(/\s+/).find((w) => w !== "sudo") ?? "";
    if (!this.ghostOn || BUILTIN_SILENT.has(first)) return;
    if (!shouldHaunt(this.level, risk, result.exitCode, line)) return;

    const now = new Date();
    const prior = sh.history[sh.history.length - 1] === line ? sh.history.slice(0, -1) : sh.history;
    const inRepo = sh.cwd === `${sh.home}/haunted-project` || sh.cwd.startsWith(`${sh.home}/haunted-project/`);
    const ctx: GhostContext = {
      command: line,
      exitCode: result.exitCode,
      cwd: displayPath(sh.cwd, sh.home),
      branch: inRepo ? sh.git.branch : null,
      hour: now.getHours(),
      minute: now.getMinutes(),
      history: prior,
      risk,
      errorStreak: sh.errorStreak,
      level: this.level,
      persona: this.persona,
      user: sh.user,
    };
    await this.whisper(ctx);
  }

  // ------------------------------------------------------------ the ghost speaks

  private async whisper(ctx: GhostContext): Promise<void> {
    const backend = this.opts.getBackend();
    const typer = new Typer(this);
    this.whispering = true;
    this.emit();
    typer.begin();
    const signal = this.abort?.signal;
    const result = await generateWhisper(ctx, {
      backend,
      signal,
      charDelayMs: 0,
      firstTokenTimeoutMs: backend && backend.kind !== "scripted" ? 40_000 : undefined,
      onUpdate: (text) => typer.setTarget(text),
    });
    if (signal?.aborted) typer.cancel();
    else typer.setTarget(result.text);
    await typer.finish();
    this.whispering = false;
    this.last = {
      source: result.source,
      fellBack: result.fellBack,
      ttftMs: result.ttftMs,
      durationMs: Math.round(result.durationMs),
      chars: result.chars,
      error: result.error,
    };
    this.emit();
  }

  /** The ghost speaks a fixed line (séance greeting, lore). No model involved. */
  private async speakStatic(text: string): Promise<void> {
    const typer = new Typer(this);
    this.whispering = true;
    this.emit();
    typer.begin();
    typer.setTarget(text);
    await typer.finish();
    this.whispering = false;
    this.emit();
  }

  private async idleWhisper(): Promise<void> {
    if (this.disposed || this.busy || !this.ghostOn || this.buffer) return;
    this.busy = true;
    this.abort = new AbortController();
    this.write("\r\n");
    this.emit();
    try {
      const sh = this.shell;
      const now = new Date();
      await this.whisper({
        command: "",
        exitCode: 0,
        cwd: displayPath(sh.cwd, sh.home),
        branch: null,
        hour: now.getHours(),
        minute: now.getMinutes(),
        history: sh.history,
        risk: assessCommand(""),
        errorStreak: 0,
        level: this.level,
        persona: this.persona,
        idleSeconds: Math.round(IDLE_FIRST_MS / 1000),
        user: sh.user,
      });
    } finally {
      this.busy = false;
      this.abort = null;
      this.hasten = false;
      if (!this.disposed) {
        this.prompt();
        this.emit();
        this.touch(IDLE_NEXT_MS);
        this.replayPending();
      }
    }
  }

  private touch(after: number = IDLE_FIRST_MS): void {
    if (this.disposed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.idleWhisper(), after);
  }

  // ------------------------------------------------------------ used by Typer

  /** @internal */ get _cols(): number {
    return this.term.cols;
  }
  /** @internal */ get _hasten(): boolean {
    return this.hasten;
  }
  /** @internal */ get _reduced(): boolean {
    return this.opts.reducedMotion;
  }
  /** @internal */ get _presence(): number {
    return this.presence;
  }
  /** @internal */ _write(s: string): void {
    this.write(s);
  }
}

/**
 * Renders a whisper with a typewriter: word-aware wrapping, an indent so the
 * ghost's voice reads as a block, and occasional glitches that grow with the
 * presence meter. Text may arrive in pieces (model tokens) or all at once.
 */
class Typer {
  private target = "";
  private printed = 0;
  private col = 0;
  private pumping = false;
  private cancelled = false;
  private dots = 0;
  private dotTimer: ReturnType<typeof setInterval> | null = null;
  private waiters: (() => void)[] = [];
  private static readonly INDENT = 2;
  private s: TerminalSession;

  constructor(s: TerminalSession) {
    this.s = s;
  }

  begin(): void {
    this.s._write(`${GHOST}~ `);
    this.col = Typer.INDENT;
    if (!this.s._reduced) {
      this.dotTimer = setInterval(() => {
        if (this.dots >= 3) {
          this.s._write("\b \b\b \b\b \b");
          this.dots = 0;
        } else {
          this.s._write(".");
          this.dots++;
        }
      }, 320);
    }
  }

  private stopDots(): void {
    if (this.dotTimer) clearInterval(this.dotTimer);
    this.dotTimer = null;
    if (this.dots > 0) this.s._write("\b \b".repeat(this.dots));
    this.dots = 0;
  }

  setTarget(text: string): void {
    if (this.cancelled || !text) return;
    const printedText = this.target.slice(0, this.printed);
    if (!text.startsWith(printedText)) return;
    this.target = text;
    this.stopDots();
    if (!this.pumping) void this.pump();
  }

  cancel(): void {
    this.cancelled = true;
    this.stopDots();
    this.s._write(`${DIM} ^C${RESET}`);
  }

  async finish(): Promise<void> {
    if (this.pumping) await new Promise<void>((r) => this.waiters.push(r));
    this.stopDots();
    this.s._write(`${RESET}\r\n\r\n`);
  }

  private nextWordLength(from: number): number {
    let n = 0;
    for (let i = from; i < this.target.length && this.target[i] !== " "; i++) n++;
    return n;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.printed < this.target.length && !this.cancelled) {
        const ch = this.target[this.printed];
        const cols = this.s._cols;
        let out = ch;
        if (ch === " ") {
          if (this.col + 1 + this.nextWordLength(this.printed + 1) > cols - 1) {
            out = `\r\n${" ".repeat(Typer.INDENT)}`;
            this.col = Typer.INDENT;
          } else this.col++;
        } else {
          if (this.col >= cols - 1) {
            out = `\r\n${" ".repeat(Typer.INDENT)}${ch}`;
            this.col = Typer.INDENT + 1;
          } else this.col++;
        }

        const rushing = this.s._hasten || this.s._reduced;
        if (!rushing && /[a-z]/i.test(ch) && this.col < cols - 4) {
          const chance = 0.01 + (this.s._presence / 100) * 0.035;
          if (Math.random() < chance) {
            this.s._write(GLITCH_GLYPHS[Math.floor(Math.random() * GLITCH_GLYPHS.length)]);
            await sleep(70);
            this.s._write("\b \b");
          }
        }

        this.s._write(out);
        this.printed++;
        if (!rushing) {
          const backlog = this.target.length - this.printed;
          const base = backlog > 70 ? 9 : 24;
          await sleep(base + Math.random() * base * (/[.,;!?]/.test(ch) ? 6 : 0.8));
        } else if (this.printed % 40 === 0) {
          await sleep(0);
        }
      }
    } finally {
      this.pumping = false;
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w();
    }
  }
}
