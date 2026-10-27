import type { Risk } from "../shell/risk.ts";
import type { GhostLevel } from "../shell/types.ts";

export type { GhostLevel };

export type BackendKind = "scripted" | "webllm" | "ollama";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

export interface LoadProgress {
  /** 0..1 */
  progress: number;
  text: string;
}

/** A local inference engine. Implementations must never talk to a remote API. */
export interface GhostBackend {
  readonly kind: BackendKind;
  readonly label: string;
  load(onProgress: (p: LoadProgress) => void): Promise<void>;
  stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<string, void, void>;
  unload(): Promise<void>;
}

/** Everything the ghost knows about the moment it is asked to speak. */
export interface GhostContext {
  /** Empty string means "the mortal has been idle". */
  command: string;
  exitCode: number;
  /** Display path, e.g. ~/haunted-project */
  cwd: string;
  branch: string | null;
  hour: number;
  minute: number;
  /** Previous commands, oldest first, excluding the current one. */
  history: string[];
  risk: Risk;
  errorStreak: number;
  level: GhostLevel;
  /** Séance persona id, or null for the default Ghost in the Shell. */
  persona: string | null;
  idleSeconds?: number;
  user: string;
}

export interface WhisperResult {
  text: string;
  source: "model" | "scripted";
  /** True when the model failed or went out of character and the scripted ghost answered instead. */
  fellBack: boolean;
  aborted: boolean;
  error?: string;
  /** Milliseconds until the first token, null for scripted whispers. */
  ttftMs: number | null;
  durationMs: number;
  chars: number;
}
