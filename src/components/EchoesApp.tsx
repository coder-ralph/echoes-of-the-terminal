"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useGhostEngine } from "@/lib/ghost/engine";
import type { SessionSnapshot } from "@/lib/term/session";
import type { ThemeId } from "@/lib/themes";
import { presenceBand } from "./PresenceLamps";
import { SeanceBoard } from "./SeanceBoard";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";

const THEME_KEY = "echoes:theme:v1";

function statusLine(snap: SessionSnapshot | null): string {
  const last = snap?.last;
  if (!last) return "Waiting for your first command.";
  if (last.fellBack) return `The model went quiet, so the scripted ghost answered. ${last.error ?? ""}`.trim();
  if (last.source === "scripted") return `Scripted whisper, ${last.chars} characters.`;
  const first = last.ttftMs !== null ? `First words in ${(last.ttftMs / 1000).toFixed(1)}s, ` : "";
  return `${first}${last.chars} characters in ${(last.durationMs / 1000).toFixed(1)}s.`.replace(/^([a-z])/, (c) => c.toUpperCase());
}

export default function EchoesApp() {
  const engine = useGhostEngine();
  const [theme, setTheme] = useState<ThemeId>("amber");
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const term = useRef<TerminalHandle>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "amber" || saved === "green") setTheme(saved);
    } catch {
      /* storage blocked: keep amber */
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const getBackend = useCallback(() => engine.backendRef.current, [engine.backendRef]);
  const presence = snap?.presence ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-10 pt-8 sm:px-6 lg:px-8">
      <header className="mb-7">
        <h1 className="echo-title m-0">Echoes of the Terminal</h1>
        <p className="lede mt-3 mb-0">
          A shell that answers back. An open-weight model on your own machine reads each command you run and whispers about it.
        </p>
      </header>

      <main className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section aria-label="Haunted terminal">
          <div className="cabinet">
            <div
              className="crt"
              data-whisper={snap?.whispering ? "true" : "false"}
              data-presence={presenceBand(presence)}
              onClick={() => term.current?.focus()}
            >
              <div className="crt-roll" aria-hidden="true" />
              <div className="crt-pad">
                <TerminalView ref={term} theme={theme} getBackend={getBackend} onChange={setSnap} />
              </div>
            </div>
          </div>
          <p className="muted mono m-0 mt-3 px-1" aria-live="polite">
            {engine.label}
            <span aria-hidden="true"> | </span>
            {statusLine(snap)}
          </p>
          <p className="muted m-0 mt-1 px-1 text-[0.95rem]">
            Your commands and history never leave this machine. Ctrl+C silences the ghost. Press any key to hurry its typing.
          </p>
        </section>

        <SeanceBoard
          engine={engine}
          snap={snap}
          theme={theme}
          onTheme={setTheme}
          onLevel={(l) => term.current?.setLevel(l)}
          onPersona={(p) => term.current?.setPersona(p)}
          onGhostOn={(on) => term.current?.setGhostOn(on)}
          onRun={(c) => void term.current?.run(c)}
        />
      </main>

      <footer className="muted mt-10 text-[0.95rem]">
        Made with ☕ by Ralph Rosael. For the DEV Hacktoberfest Open-Source AI Challenge, week 4: Ghost in the Machine. MIT licensed.
      </footer>
    </div>
  );
}
