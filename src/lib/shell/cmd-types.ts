import type { ShellAction, ShellState } from "./types.ts";

export interface Ctx {
  sh: ShellState;
  /** Lines piped in from the previous command, or null when there is no pipe. */
  stdin: string[] | null;
  sudo: boolean;
}

export interface CmdOut {
  out?: string[];
  err?: string[];
  code: number;
  clear?: boolean;
  actions?: ShellAction[];
}

export type Cmd = (ctx: Ctx, args: string[]) => CmdOut;

export const ok = (...out: string[]): CmdOut => ({ out, code: 0 });
export const fail = (message: string, code = 1): CmdOut => ({ err: [message], code });
