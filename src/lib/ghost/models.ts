/**
 * Curated model choices. WebLLM ids were checked against the prebuilt model
 * list shipped in @mlc-ai/web-llm 0.2.86; VRAM figures are the library's own
 * `vram_required_MB` for the q4f16_1 builds (they need WebGPU shader-f16).
 */

export interface ModelOption {
  id: string;
  label: string;
  /** Rough GPU memory the library reports it needs, in MB (WebLLM only). */
  vramMB?: number;
  note: string;
}

export const WEBLLM_MODELS: ModelOption[] = [
  { id: "gemma3-1b-it-q4f16_1-MLC", label: "Gemma 3 1B", vramMB: 711, note: "Google's open-weight Gemma 3; the smallest download that still has a voice" },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M", vramMB: 376, note: "tiny and instant; a flimsy ghost" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", vramMB: 879, note: "fast and in character" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B", vramMB: 945, note: "small and snappy" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B", vramMB: 1630, note: "sharper wit" },
  { id: "gemma-2-2b-it-q4f16_1-MLC-1k", label: "Gemma 2 2B", vramMB: 1583, note: "Google's open-weight Gemma 2" },
  { id: "gemma-4-E2B-it-q4f16_1-MLC", label: "Gemma 4 E2B", vramMB: 3387, note: "newest Gemma; wants a mid-range GPU" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", vramMB: 2264, note: "best quality under 3 GB" },
  { id: "Llama-3-8B-Instruct-q4f16_1-MLC-1k", label: "Llama 3 8B", vramMB: 4598, note: "the grand spirit; needs a real GPU" },
  { id: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC", label: "Qwen2.5 Coder 7B", vramMB: 5107, note: "knows your commands intimately" },
];

export const DEFAULT_WEBLLM_MODEL = "gemma3-1b-it-q4f16_1-MLC";

export const OLLAMA_MODELS: ModelOption[] = [
  { id: "llama3.2:3b", label: "Llama 3.2 3B", note: "ollama pull llama3.2:3b" },
  { id: "llama3.2:1b", label: "Llama 3.2 1B", note: "ollama pull llama3.2:1b" },
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", note: "ollama pull qwen2.5-coder:7b" },
  { id: "gemma3:4b", label: "Gemma 3 4B", note: "ollama pull gemma3:4b" },
  { id: "llama3.1:8b", label: "Llama 3.1 8B", note: "ollama pull llama3.1:8b" },
];

export const DEFAULT_OLLAMA_MODEL = "gemma3:4b";

/** Tried in order when the configured model is not installed. Anything else falls back to the first pulled model. */
export const OLLAMA_PREFERENCE = ["gemma3:4b", "llama3.2:3b", "llama3.2:1b", "gemma3:1b", "qwen2.5-coder:7b", "llama3.1:8b"];
