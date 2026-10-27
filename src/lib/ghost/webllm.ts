/**
 * WebLLM backend: runs an open-weight model entirely inside the browser via
 * WebGPU. Weights are downloaded once from the Hugging Face / MLC mirrors and
 * then cached by the browser, so later sessions work with the network off.
 *
 * Browser-only. The library and the worker are loaded lazily on first summon.
 */

import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import type { ChatMessage, GhostBackend, LoadProgress, StreamOptions } from "./types.ts";

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export class WebLLMBackend implements GhostBackend {
  readonly kind = "webllm" as const;
  readonly modelId: string;
  private engine: MLCEngineInterface | null = null;
  private worker: Worker | null = null;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  get label(): string {
    return `WebLLM · ${this.modelId.replace(/-MLC(-1k)?$/, "").replace(/-q\d.*$/, "")}`;
  }

  async load(onProgress: (p: LoadProgress) => void): Promise<void> {
    if (!webGpuAvailable()) {
      throw new Error("WebGPU is not available in this browser. Try recent Chrome or Edge, or use the Ollama backend.");
    }
    onProgress({ progress: 0, text: "Opening the grimoire..." });
    const webllm = await import("@mlc-ai/web-llm");
    this.worker = new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" });
    this.engine = await webllm.CreateWebWorkerMLCEngine(this.worker, this.modelId, {
      initProgressCallback: (report) => onProgress({ progress: report.progress, text: report.text }),
    });
  }

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<string, void, void> {
    const engine = this.engine;
    if (!engine) throw new Error("The model has not been summoned yet.");
    let finished = false;
    try {
      const chunks = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        top_p: 0.9,
      });
      for await (const chunk of chunks) {
        if (opts.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
      finished = true;
    } finally {
      // Stopped early (abort, sentence cap, or error): tell the engine to stop generating.
      if (!finished) await engine.interruptGenerate();
    }
  }

  async unload(): Promise<void> {
    try {
      await this.engine?.unload();
    } catch {
      /* already gone */
    }
    this.worker?.terminate();
    this.engine = null;
    this.worker = null;
  }
}
