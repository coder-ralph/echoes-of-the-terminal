/**
 * The whisper pipeline: context -> prompt -> (local model | scripted ghost) ->
 * cleaned, streamed text. Pure and environment-agnostic so it runs in the
 * browser, in tests and in the CLI companion.
 */

import { LEVELS, buildMessages } from "./prompt.ts";
import { scriptedWhisper } from "./scripted.ts";
import type { Rng } from "./scripted.ts";
import { cleanStreaming, completeSentences, finalizeWhisper, limitSentences, truncateChars } from "./text.ts";
import type { ChatMessage, GhostBackend, GhostContext, WhisperResult } from "./types.ts";

export interface WhisperInfo {
  source: "model" | "scripted";
  done: boolean;
}

export interface WhisperOptions {
  /** null (or a scripted backend) means: use the hand-written ghost. */
  backend: GhostBackend | null;
  onUpdate: (text: string, info: WhisperInfo) => void;
  onPrompt?: (messages: ChatMessage[]) => void;
  signal?: AbortSignal;
  rng?: Rng;
  /** Typewriter delay for scripted whispers. 0 disables the delay (tests). */
  charDelayMs?: number;
  /** Give up on the model and fall back to scripted if no token arrives in time. */
  firstTokenTimeoutMs?: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

async function typewriter(text: string, opts: WhisperOptions): Promise<string> {
  const delay = opts.charDelayMs ?? 22;
  if (delay <= 0) {
    opts.onUpdate(text, { source: "scripted", done: false });
    return text;
  }
  let shown = "";
  for (let i = 1; i <= text.length; i++) {
    if (opts.signal?.aborted) return shown;
    shown = text.slice(0, i);
    opts.onUpdate(shown, { source: "scripted", done: false });
    await sleep(delay + Math.random() * delay, opts.signal);
  }
  return shown;
}

async function scriptedResult(ctx: GhostContext, opts: WhisperOptions, started: number, extra: Partial<WhisperResult> = {}): Promise<WhisperResult> {
  const text = scriptedWhisper(ctx, opts.rng);
  const shown = await typewriter(text, opts);
  const aborted = !!opts.signal?.aborted;
  opts.onUpdate(shown, { source: "scripted", done: true });
  return {
    text: shown,
    source: "scripted",
    fellBack: false,
    aborted,
    ttftMs: null,
    durationMs: now() - started,
    chars: shown.length,
    ...extra,
  };
}

export async function generateWhisper(ctx: GhostContext, opts: WhisperOptions): Promise<WhisperResult> {
  const started = now();
  const level = LEVELS[ctx.level];
  const messages = buildMessages(ctx);
  opts.onPrompt?.(messages);

  const backend = opts.backend;
  if (!backend || backend.kind === "scripted") return scriptedResult(ctx, opts, started);

  const controller = new AbortController();
  let userAborted = false;
  let timedOut = false;
  const onAbort = () => {
    userAborted = true;
    controller.abort();
  };
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.firstTokenTimeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.firstTokenTimeoutMs);
  }

  let raw = "";
  let ttft: number | null = null;
  let failure: string | undefined;

  try {
    const stream = backend.stream(messages, {
      maxTokens: level.maxTokens,
      temperature: level.temperature,
      signal: controller.signal,
    });
    for await (const delta of stream) {
      if (ttft === null) {
        ttft = now() - started;
        if (timer) clearTimeout(timer);
      }
      raw += delta;
      const cleaned = cleanStreaming(raw);
      const complete = completeSentences(cleaned);
      const shown = truncateChars(limitSentences(cleaned, level.maxSentences), level.maxChars);
      opts.onUpdate(shown, { source: "model", done: false });
      // Enough said: stop generating as soon as the sentence budget is spent.
      if (complete.length >= level.maxSentences || cleaned.length > level.maxChars + 40) break;
    }
  } catch (err) {
    if (!userAborted) {
      failure = timedOut ? "The model took too long to answer." : err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (userAborted) {
    const partial = finalizeWhisper(raw, level.maxSentences, level.maxChars) ?? cleanStreaming(raw).trim();
    opts.onUpdate(partial, { source: "model", done: true });
    return { text: partial, source: "model", fellBack: false, aborted: true, ttftMs: ttft, durationMs: now() - started, chars: partial.length };
  }

  const final = failure ? null : finalizeWhisper(raw, level.maxSentences, level.maxChars);
  if (final) {
    opts.onUpdate(final, { source: "model", done: true });
    return { text: final, source: "model", fellBack: false, aborted: false, ttftMs: ttft, durationMs: now() - started, chars: final.length };
  }

  // The model failed, timed out, or broke character: the scripted ghost takes over.
  return scriptedResult(ctx, opts, started, {
    fellBack: true,
    error: failure ?? "The model broke character, so the ghost answered in its own voice.",
    ttftMs: ttft,
  });
}
