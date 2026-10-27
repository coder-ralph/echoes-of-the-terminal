"use client";

/**
 * Engine manager (React hook). Owns the lifecycle of the local inference
 * backend: scripted ghost (no model), WebLLM (in-browser WebGPU) or Ollama
 * (local HTTP). Nothing here ever talks to a remote API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_WEBLLM_MODEL } from "./models.ts";
import { DEFAULT_OLLAMA_URL, OllamaBackend, isLoopbackUrl, listOllamaModels, modelIsPulled, pickOllamaModel } from "./ollama.ts";
import type { BackendKind, GhostBackend, LoadProgress } from "./types.ts";
import { WebLLMBackend, webGpuAvailable } from "./webllm.ts";

export type EngineStatus = "idle" | "loading" | "ready" | "error";

export interface EngineSettings {
  kind: BackendKind;
  webllmModel: string;
  ollamaModel: string;
  ollamaUrl: string;
  /** Set after a successful load, so a returning visitor wakes the cached model automatically. */
  autoSummon: boolean;
}

const STORAGE_KEY = "echoes:engine:v1";

const DEFAULTS: EngineSettings = {
  kind: "scripted",
  webllmModel: DEFAULT_WEBLLM_MODEL,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  autoSummon: false,
};

function readSettings(): EngineSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EngineSettings>) };
  } catch {
    /* storage unavailable: run with defaults */
  }
  return DEFAULTS;
}

function writeSettings(s: EngineSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Heuristic check of the browser Cache API for already-downloaded WebLLM weights. */
export async function isModelCached(modelId: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open("webllm/model");
    const keys = await cache.keys();
    return keys.some((k) => k.url.includes(modelId));
  } catch {
    return false;
  }
}

function friendlyLoadError(err: unknown, kind: BackendKind): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (kind === "webllm") {
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return "Could not download the model weights. Check your connection and try again. After one full download the model works offline.";
    }
    if (/f16/i.test(msg)) return "This GPU does not support 16-bit shaders (shader-f16), which these models need. Use Ollama instead.";
    if (/out of memory|oom|device lost/i.test(msg)) return "The GPU ran out of memory. Pick a smaller model.";
  }
  return msg;
}

export interface EngineApi {
  settings: EngineSettings;
  status: EngineStatus;
  progress: LoadProgress;
  error: string | null;
  /** The live backend, or null while the scripted ghost is speaking. */
  backend: GhostBackend | null;
  backendRef: React.RefObject<GhostBackend | null>;
  label: string;
  webGpu: boolean;
  cached: boolean;
  ollamaModels: string[];
  update: (patch: Partial<EngineSettings>) => void;
  summon: () => Promise<void>;
  release: () => Promise<void>;
  refreshOllama: () => Promise<void>;
}

export function useGhostEngine(): EngineApi {
  const [settings, setSettings] = useState<EngineSettings>(DEFAULTS);
  const [status, setStatus] = useState<EngineStatus>("idle");
  const [progress, setProgress] = useState<LoadProgress>({ progress: 0, text: "" });
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<GhostBackend | null>(null);
  const [webGpu, setWebGpu] = useState(false);
  const [cached, setCached] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const backendRef = useRef<GhostBackend | null>(null);
  const settingsRef = useRef(settings);
  const loadToken = useRef(0);

  settingsRef.current = settings;

  const dispose = useCallback(async () => {
    loadToken.current++;
    const old = backendRef.current;
    backendRef.current = null;
    setBackend(null);
    if (old) await old.unload();
  }, []);

  const summonWith = useCallback(
    async (s: EngineSettings) => {
      await dispose();
      if (s.kind === "scripted") {
        setStatus("idle");
        setError(null);
        return;
      }
      if (s.kind === "ollama" && !isLoopbackUrl(s.ollamaUrl)) {
        setStatus("error");
        setError("That address is not on this computer. Echoes only talks to Ollama at localhost, so your commands never leave your machine.");
        return;
      }
      const token = ++loadToken.current;
      const next: GhostBackend = s.kind === "webllm" ? new WebLLMBackend(s.webllmModel) : new OllamaBackend(s.ollamaModel, s.ollamaUrl);
      setStatus("loading");
      setError(null);
      setProgress({ progress: 0, text: "" });
      try {
        await next.load((p) => {
          if (token === loadToken.current) setProgress(p);
        });
        if (token !== loadToken.current) {
          await next.unload();
          return;
        }
        backendRef.current = next;
        setBackend(next);
        setStatus("ready");
        const saved = { ...s, autoSummon: true };
        setSettings(saved);
        writeSettings(saved);
        if (s.kind === "webllm") setCached(true);
      } catch (err) {
        if (token !== loadToken.current) return;
        await next.unload();
        setStatus("error");
        setError(friendlyLoadError(err, s.kind));
      }
    },
    [dispose],
  );

  const refreshOllama = useCallback(async () => {
    const pulled = await listOllamaModels(settingsRef.current.ollamaUrl);
    setOllamaModels(pulled);
    // The configured model is not installed: switch to one that is, so Connect just works.
    const current = settingsRef.current.ollamaModel;
    if (pulled.length && !modelIsPulled(current, pulled)) {
      const better = pickOllamaModel(pulled);
      if (better) {
        const next = { ...settingsRef.current, ollamaModel: better };
        setSettings(next);
        writeSettings(next);
      }
    }
  }, []);

  const update = useCallback(
    (patch: Partial<EngineSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      const switched = patch.kind !== undefined && patch.kind !== settingsRef.current.kind;
      const modelChanged =
        (patch.webllmModel !== undefined && patch.webllmModel !== settingsRef.current.webllmModel) ||
        (patch.ollamaModel !== undefined && patch.ollamaModel !== settingsRef.current.ollamaModel);
      if (switched || modelChanged) {
        next.autoSummon = false;
        void dispose();
        setStatus("idle");
        setError(null);
      }
      setSettings(next);
      writeSettings(next);
    },
    [dispose],
  );

  // First mount: restore saved settings, probe WebGPU, wake a previously loaded model.
  useEffect(() => {
    const saved = readSettings();
    setSettings(saved);
    setWebGpu(webGpuAvailable());
    if (saved.autoSummon && saved.kind !== "scripted") void summonWith(saved);
    return () => {
      void dispose();
    };
  }, [summonWith, dispose]);

  useEffect(() => {
    if (settings.kind !== "webllm") return;
    let live = true;
    void isModelCached(settings.webllmModel).then((c) => live && setCached(c));
    return () => {
      live = false;
    };
  }, [settings.kind, settings.webllmModel]);

  const label = useMemo(() => {
    if (backend) return backend.label;
    return "Scripted ghost · no model";
  }, [backend]);

  return {
    settings,
    status,
    progress,
    error,
    backend,
    backendRef,
    label,
    webGpu,
    cached,
    ollamaModels,
    update,
    summon: () => summonWith(settingsRef.current),
    release: dispose,
    refreshOllama,
  };
}
