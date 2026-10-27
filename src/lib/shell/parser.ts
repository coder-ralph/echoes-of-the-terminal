/**
 * A small shell lexer/parser: quotes, backslash escapes, `&&`, `||`, `;`, `|`,
 * `>` and `>>`. No subshells, no heredocs; this is a theatre set, not bash.
 */

export interface Word {
  kind: "word";
  value: string;
  /** True when any part of the word was single-quoted (suppresses expansion). */
  literal: boolean;
  /** True when any part of the word was quoted at all (suppresses globbing). */
  quoted: boolean;
}

export interface Op {
  kind: "op";
  value: "&&" | "||" | ";" | "|" | ">" | ">>";
}

export type Token = Word | Op;

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let has = false;
  let literal = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const pushWord = () => {
    if (has) tokens.push({ kind: "word", value: cur, literal, quoted });
    cur = "";
    has = false;
    literal = false;
    quoted = false;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      quoted = true;
      if (ch === "'") literal = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>") {
      pushWord();
      tokens.push({ kind: "op", value: two });
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === ">") {
      pushWord();
      tokens.push({ kind: "op", value: ch });
      continue;
    }
    cur += ch;
    has = true;
  }
  pushWord();
  return tokens;
}

export interface SimpleCommand {
  argv: Word[];
  redirect: { mode: ">" | ">>"; target: Word } | null;
}

export interface ChainEntry {
  /** How this pipeline is joined to the previous one. */
  joiner: "&&" | "||" | ";" | null;
  pipeline: SimpleCommand[];
}

export function parse(tokens: Token[]): ChainEntry[] {
  const chain: ChainEntry[] = [];
  let joiner: ChainEntry["joiner"] = null;
  let pipeline: SimpleCommand[] = [];
  let cmd: SimpleCommand = { argv: [], redirect: null };
  let expectTarget: ">" | ">>" | null = null;

  const endCmd = () => {
    if (cmd.argv.length) pipeline.push(cmd);
    cmd = { argv: [], redirect: null };
  };
  const endPipeline = () => {
    endCmd();
    if (pipeline.length) chain.push({ joiner, pipeline });
    pipeline = [];
  };

  for (const t of tokens) {
    if (t.kind === "word") {
      if (expectTarget) {
        cmd.redirect = { mode: expectTarget, target: t };
        expectTarget = null;
      } else {
        cmd.argv.push(t);
      }
      continue;
    }
    switch (t.value) {
      case "|":
        endCmd();
        break;
      case ">":
      case ">>":
        expectTarget = t.value;
        break;
      case "&&":
      case "||":
      case ";":
        endPipeline();
        joiner = t.value;
        break;
    }
  }
  endPipeline();
  return chain;
}
