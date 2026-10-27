/**
 * Shared types for the simulated shell.
 * Everything under src/lib/shell and src/lib/ghost is pure TypeScript with no
 * DOM or framework imports, so the same code runs in the browser, in tests and
 * in the real-shell CLI companion (cli/haunt.ts).
 */

export type GhostLevel = "whisper" | "haunt" | "possess";

export type VNode =
  | { type: "dir"; children: Record<string, VNode> }
  | { type: "file"; content: string };

export interface Commit {
  hash: string;
  message: string;
  author: string;
  when: string;
}

export interface GitState {
  branch: string;
  branches: string[];
  commits: Commit[];
  staged: string[];
  modified: string[];
  untracked: string[];
  forcePushes: number;
  stashes: number;
}

export interface ShellState {
  fs: VNode;
  cwd: string;
  home: string;
  user: string;
  host: string;
  history: string[];
  git: GitState;
  lastExit: number;
  /** Count of consecutive non-zero exits, used by the ghost to get smug. */
  errorStreak: number;
  commandCount: number;
}

export type ShellAction =
  | { type: "ghost-level"; level: GhostLevel }
  | { type: "ghost-power"; on: boolean }
  | { type: "seance"; persona: string | null }
  | { type: "exorcise"; history: boolean }
  | { type: "lore" }
  | { type: "exit" };

export interface OutLine {
  kind: "out" | "err";
  text: string;
}

export interface ExecResult {
  lines: OutLine[];
  exitCode: number;
  clear: boolean;
  actions: ShellAction[];
}
