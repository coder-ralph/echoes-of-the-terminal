"use client";

import { useEffect } from "react";
import type { EngineApi } from "@/lib/ghost/engine";
import { isLoopbackUrl } from "@/lib/ghost/ollama";
import { OLLAMA_MODELS, WEBLLM_MODELS } from "@/lib/ghost/models";
import { PERSONAS } from "@/lib/ghost/personas";
import { LEVELS } from "@/lib/ghost/prompt";
import type { BackendKind, GhostLevel } from "@/lib/ghost/types";
import type { SessionSnapshot } from "@/lib/term/session";
import { THEME_IDS, THEMES } from "@/lib/themes";
import type { ThemeId } from "@/lib/themes";
import { PresenceLamps } from "./PresenceLamps";

const EXAMPLES = ["git push --force", "rm -rf node_modules", "cat .env", "npm test", "gti status", "sudo rm -rf /"];

interface Props {
  engine: EngineApi;
  snap: SessionSnapshot | null;
  theme: ThemeId;
  onTheme: (t: ThemeId) => void;
  onLevel: (l: GhostLevel) => void;
  onPersona: (id: string | null) => void;
  onGhostOn: (on: boolean) => void;
  onRun: (command: string) => void;
}

const KINDS: { id: BackendKind; name: string; blurb: string }[] = [
  { id: "scripted", name: "Scripted ghost", blurb: "Hand-written lines. Instant, no download, works anywhere." },
  { id: "webllm", name: "A model in this browser", blurb: "Open weights run on your GPU through WebLLM. Downloads once, then works offline." },
  { id: "ollama", name: "Ollama on this computer", blurb: "Use a model you already run locally with Ollama." },
];

export function SeanceBoard({ engine, snap, theme, onTheme, onLevel, onPersona, onGhostOn, onRun }: Props) {
  const { settings, status } = engine;
  const level = snap?.level ?? "haunt";
  const persona = snap?.persona ?? null;
  const personaInfo = PERSONAS.find((p) => p.id === persona);
  const modelInfo = WEBLLM_MODELS.find((m) => m.id === settings.webllmModel);
  const loading = status === "loading";
  const urlOk = isLoopbackUrl(settings.ollamaUrl);

  useEffect(() => {
    if (settings.kind === "ollama") void engine.refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.kind, settings.ollamaUrl]);

  return (
    <aside className="board" aria-label="Séance board">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2>Séance board</h2>
          <p className="muted m-0 text-[0.98rem]">Choose who answers from the other side.</p>
        </div>
        <div className="flex gap-2 pt-1.5" role="group" aria-label="Phosphor colour">
          {THEME_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="swatch"
              aria-pressed={theme === id}
              aria-label={`${THEMES[id].label} phosphor`}
              title={`${THEMES[id].label} phosphor`}
              style={{ background: THEMES[id].xterm.foreground }}
              onClick={() => onTheme(id)}
            />
          ))}
        </div>
      </div>

      <section className="board-section" aria-labelledby="voice-h">
        <fieldset className="m-0 border-0 p-0">
          <legend id="voice-h" className="mb-1 p-0 italic" style={{ color: "var(--phos-bright)" }}>
            Voice
          </legend>
          {KINDS.map((k) => (
            <label key={k.id} className="choice">
              <input type="radio" name="engine" value={k.id} checked={settings.kind === k.id} onChange={() => engine.update({ kind: k.id })} />
              <span>
                <strong>{k.name}</strong>
                <span className="muted block text-[0.95rem]">{k.blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {settings.kind === "webllm" && (
          <div className="mt-3 space-y-3">
            {!engine.webGpu && (
              <p className="notice" role="alert">
                This browser has no WebGPU. Use a recent Chrome or Edge, or switch to Ollama.
              </p>
            )}
            <div>
              <label htmlFor="webllm-model" className="muted text-[0.95rem]">
                Model
              </label>
              <select
                id="webllm-model"
                className="field"
                value={settings.webllmModel}
                disabled={loading}
                onChange={(e) => engine.update({ webllmModel: e.target.value })}
              >
                {WEBLLM_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.vramMB ? `${(m.vramMB / 1000).toFixed(1)} GB GPU` : ""}
                  </option>
                ))}
              </select>
              <p className="muted m-0 mt-1 text-[0.92rem]">
                {modelInfo?.note}.{" "}
                {engine.cached ? "Already downloaded, so it works offline." : "First run downloads the weights once."}
              </p>
            </div>
            <Loader engine={engine} verb={engine.cached ? "Wake the model" : "Download and wake"} disabled={!engine.webGpu} />
          </div>
        )}

        {settings.kind === "ollama" && (
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="ollama-url" className="muted text-[0.95rem]">
                Ollama address
              </label>
              <input
                id="ollama-url"
                className="field"
                value={settings.ollamaUrl}
                spellCheck={false}
                disabled={loading}
                onChange={(e) => engine.update({ ollamaUrl: e.target.value })}
                aria-invalid={!urlOk}
              />
              {!urlOk && (
                <p className="notice" role="alert">
                  Use an address on this computer, such as http://localhost:11434.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="ollama-model" className="muted text-[0.95rem]">
                Model
              </label>
              <input
                id="ollama-model"
                className="field"
                list="ollama-models"
                value={settings.ollamaModel}
                spellCheck={false}
                disabled={loading}
                onChange={(e) => engine.update({ ollamaModel: e.target.value })}
              />
              <datalist id="ollama-models">
                {(engine.ollamaModels.length ? engine.ollamaModels : OLLAMA_MODELS.map((m) => m.id)).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="muted m-0 mt-1 text-[0.92rem]">
                {engine.ollamaModels.length ? `${engine.ollamaModels.length} models found.` : "No models found yet. Run ollama pull llama3.2:3b."}
              </p>
            </div>
            <Loader engine={engine} verb="Connect" disabled={!urlOk} />
            <details className="muted text-[0.92rem]">
              <summary className="cursor-pointer">Browser says it cannot reach Ollama?</summary>
              <p className="mt-2">
                Browsers enforce CORS. Start Ollama with your page&apos;s origin allowed:
              </p>
              <code className="mono block break-words">OLLAMA_ORIGINS=&quot;http://localhost:3000&quot; ollama serve</code>
            </details>
          </div>
        )}

        {settings.kind === "scripted" && (
          <p className="muted mt-2 text-[0.92rem]">Want it sharper? Pick a model above. The scripted ghost keeps talking while it loads.</p>
        )}
      </section>

      <section className="board-section" aria-labelledby="intensity-h">
        <h3 id="intensity-h" className="m-0 mb-2 font-normal italic" style={{ color: "var(--phos-bright)" }}>
          Intensity
        </h3>
        <div className="segmented" role="radiogroup" aria-label="Intensity">
          {(Object.keys(LEVELS) as GhostLevel[]).map((l) => (
            <label key={l}>
              <input type="radio" name="level" value={l} checked={level === l} onChange={() => onLevel(l)} />
              {LEVELS[l].label}
            </label>
          ))}
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[0.98rem]">
          <input
            type="checkbox"
            checked={snap?.ghostOn ?? true}
            onChange={(e) => onGhostOn(e.target.checked)}
            className="h-4 w-4"
            style={{ accentColor: "var(--phos)" }}
          />
          Let the ghost speak
        </label>
      </section>

      <section className="board-section" aria-labelledby="seance-h">
        <label id="seance-h" htmlFor="persona" className="mb-1 block italic" style={{ color: "var(--phos-bright)" }}>
          Séance
        </label>
        <select id="persona" className="field" value={persona ?? ""} onChange={(e) => onPersona(e.target.value || null)}>
          <option value="">The Ghost in the Shell</option>
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="muted m-0 mt-1 text-[0.92rem]">{personaInfo ? personaInfo.epitaph : "Channel a dead technology to comment on your commands."}</p>
      </section>

      <section className="board-section" aria-labelledby="presence-h">
        <h3 id="presence-h" className="m-0 mb-2 font-normal italic" style={{ color: "var(--phos-bright)" }}>
          Presence
        </h3>
        <PresenceLamps value={snap?.presence ?? 0} />
        <p className="muted m-0 mt-2 text-[0.92rem]">Dangerous commands and failures wake it. Safe ones calm it.</p>
      </section>

      <section className="board-section" aria-labelledby="try-h">
        <h3 id="try-h" className="m-0 mb-2 font-normal italic" style={{ color: "var(--phos-bright)" }}>
          Try a forbidden command
        </h3>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((c) => (
            <button key={c} type="button" className="chip" disabled={snap?.busy} onClick={() => onRun(c)}>
              {c}
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function Loader({ engine, verb, disabled }: { engine: EngineApi; verb: string; disabled?: boolean }) {
  const { status, progress, error } = engine;
  if (status === "loading") {
    return (
      <div aria-live="polite">
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.progress * 100)}>
          <i style={{ width: `${Math.max(3, Math.round(progress.progress * 100))}%` }} />
        </div>
        <p className="muted m-0 mt-1 line-clamp-2 text-[0.92rem]">{progress.text || "Working..."}</p>
        <button type="button" className="btn mt-2" onClick={() => void engine.release()}>
          Cancel
        </button>
      </div>
    );
  }
  if (status === "ready") {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 italic" style={{ color: "var(--ghost)" }}>
          The model is awake.
        </p>
        <button type="button" className="btn" onClick={() => void engine.release()}>
          Release
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" className="btn btn-solid" disabled={disabled} onClick={() => void engine.summon()}>
        {verb}
      </button>
      {status === "error" && error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
