"use client";

import type { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { GhostBackend, GhostLevel } from "@/lib/ghost/types";
import { TerminalSession } from "@/lib/term/session";
import type { SessionSnapshot } from "@/lib/term/session";
import { THEMES } from "@/lib/themes";
import type { ThemeId } from "@/lib/themes";

export interface TerminalHandle {
  run: (command: string) => Promise<void>;
  setLevel: (level: GhostLevel) => void;
  setPersona: (id: string | null) => void;
  setGhostOn: (on: boolean) => void;
  focus: () => void;
}

interface Props {
  theme: ThemeId;
  getBackend: () => GhostBackend | null;
  onChange: (s: SessionSnapshot) => void;
}

const fontSizeFor = (width: number) => (width < 520 ? 18 : width < 900 ? 20 : 22);

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ theme, getBackend, onChange }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<TerminalSession | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const themeRef = useRef(theme);
  const getBackendRef = useRef(getBackend);
  const onChangeRef = useRef(onChange);
  themeRef.current = theme;
  getBackendRef.current = getBackend;
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    run: (c) => session.current?.runCommand(c) ?? Promise.resolve(),
    setLevel: (l) => session.current?.setLevel(l),
    setPersona: (p) => session.current?.setPersona(p),
    setGhostOn: (on) => session.current?.setGhostOn(on),
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      try {
        await document.fonts.load('22px "VT323"');
      } catch {
        /* the fallback monospace face is fine */
      }
      const el = host.current;
      if (disposed || !el) return;

      const term = new Terminal({
        fontFamily: '"VT323", ui-monospace, Menlo, monospace',
        fontSize: fontSizeFor(el.clientWidth),
        lineHeight: 1.08,
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 1500,
        screenReaderMode: true,
        allowProposedApi: false,
        theme: THEMES[themeRef.current].xterm,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      term.textarea?.setAttribute("aria-label", "Terminal input. Type a shell command and press Enter.");

      const refit = () => {
        const size = fontSizeFor(el.clientWidth);
        if (term.options.fontSize !== size) term.options.fontSize = size;
        try {
          fit.fit();
        } catch {
          /* element not measurable yet */
        }
      };
      refit();
      const ro = new ResizeObserver(refit);
      ro.observe(el);

      const s = new TerminalSession({
        term,
        getBackend: () => getBackendRef.current(),
        onChange: (snap) => onChangeRef.current(snap),
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      session.current = s;
      termRef.current = term;
      void s.start();

      cleanup = () => {
        ro.disconnect();
        s.dispose();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
      session.current = null;
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme].xterm;
  }, [theme]);

  return <div ref={host} className="h-full w-full" />;
});
