/**
 * Ollama backend: talks to a lightweight local Ollama instance over its
 * HTTP API (default http://localhost:11434). Nothing leaves your machine.
 *
 * Browsers enforce CORS, so Ollama must allow this page's origin, e.g.
 *   OLLAMA_ORIGINS="http://localhost:3000" ollama serve
 * Uses only `fetch`, so it also runs unchanged in Node (see cli/haunt.ts).
 */

import { OLLAMA_PREFERENCE } from "./models.ts";
import type { ChatMessage, GhostBackend, LoadProgress, StreamOptions } from "./types.ts";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Privacy guard: commands may only be sent to an inference server on this very machine. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

function friendlyFetchError(err: unknown, baseUrl: string): Error {
  if (err instanceof Error && err.name === "AbortError") return err;
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost:3000";
  return new Error(
    `Could not reach Ollama at ${baseUrl}. Is it running? If this page is not served by Ollama's own origin, start it with: OLLAMA_ORIGINS="${origin}" ollama serve`,
  );
}

export async function listOllamaModels(baseUrl: string = DEFAULT_OLLAMA_URL, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export function modelIsPulled(wanted: string, pulled: string[]): boolean {
  if (pulled.includes(wanted)) return true;
  return !wanted.includes(":") && pulled.some((n) => n.startsWith(`${wanted}:`));
}

/** Choose the best installed model: the preferred list first, then whatever is pulled. */
export function pickOllamaModel(pulled: string[]): string | null {
  for (const want of OLLAMA_PREFERENCE) if (modelIsPulled(want, pulled)) return pulled.find((n) => n === want) ?? pulled.find((n) => n.startsWith(`${want}:`)) ?? want;
  return pulled[0] ?? null;
}

export class OllamaBackend implements GhostBackend {
  readonly kind = "ollama" as const;
  readonly model: string;
  readonly baseUrl: string;

  constructor(model: string, baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get label(): string {
    return `Ollama · ${this.model}`;
  }

  async load(onProgress: (p: LoadProgress) => void): Promise<void> {
    onProgress({ progress: 0.1, text: `Knocking on ${this.baseUrl}...` });
    let pulled: string[];
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pulled = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    } catch (err) {
      throw friendlyFetchError(err, this.baseUrl);
    }
    if (!modelIsPulled(this.model, pulled)) {
      throw new Error(`Model "${this.model}" is not pulled yet. Run: ollama pull ${this.model}`);
    }
    onProgress({ progress: 0.5, text: `Waking ${this.model} into memory...` });
    try {
      // An empty chat request loads the model and keeps it resident.
      const warm = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages: [], keep_alive: "15m", stream: false }),
      });
      if (!warm.ok) throw new Error(`HTTP ${warm.status}`);
    } catch (err) {
      throw friendlyFetchError(err, this.baseUrl);
    }
    onProgress({ progress: 1, text: "The model stirs." });
  }

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<string, void, void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let finished = false;
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            messages,
            stream: true,
            keep_alive: "15m",
            options: { temperature: opts.temperature, num_predict: opts.maxTokens, top_p: 0.9 },
          }),
        });
      } catch (err) {
        throw friendlyFetchError(err, this.baseUrl);
      }
      if (!res.ok || !res.body) throw new Error(`Ollama replied with HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const obj = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean };
          if (obj.error) throw new Error(obj.error);
          if (obj.message?.content) yield obj.message.content;
          if (obj.done) {
            finished = true;
            return;
          }
        }
      }
      finished = true;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (!finished) controller.abort();
    }
  }

  async unload(): Promise<void> {
    try {
      // keep_alive: 0 asks Ollama to evict the model from memory immediately.
      await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages: [], keep_alive: 0, stream: false }),
      });
    } catch {
      /* the ghost is already gone */
    }
  }
}
