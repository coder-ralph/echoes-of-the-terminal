import type { ITheme } from "@xterm/xterm";

export type ThemeId = "amber" | "green";

export interface Phosphor {
  id: ThemeId;
  label: string;
  /** xterm palette. The terminal only ever uses palette indexes, so a theme switch recolours everything already printed. */
  xterm: ITheme;
}

/**
 * Palette index map used by the session when it writes ANSI:
 *   32 (green)   user@host in the prompt
 *   34 (blue)    working directory
 *   33 (yellow)  git branch
 *   35 (magenta) the ghost
 *   31 (red)     errors and danger
 *   90 (grey)    dim text
 */
export const THEMES: Record<ThemeId, Phosphor> = {
  amber: {
    id: "amber",
    label: "Amber",
    xterm: {
      background: "#120a03",
      foreground: "#ffb23e",
      cursor: "#ffd27a",
      cursorAccent: "#120a03",
      selectionBackground: "#6b4310",
      black: "#120a03",
      red: "#ff6a4d",
      green: "#ffd27a",
      yellow: "#fff0c2",
      blue: "#c4813a",
      magenta: "#a9c8ff",
      cyan: "#7fb0ff",
      white: "#ffb23e",
      brightBlack: "#8a5a1f",
      brightRed: "#ff8a70",
      brightGreen: "#ffe3a3",
      brightYellow: "#fff7dc",
      brightBlue: "#e0a15a",
      brightMagenta: "#cfe0ff",
      brightCyan: "#a5c8ff",
      brightWhite: "#ffe9bd",
    },
  },
  green: {
    id: "green",
    label: "Green",
    xterm: {
      background: "#07110a",
      foreground: "#5cf08a",
      cursor: "#b8ffd0",
      cursorAccent: "#07110a",
      selectionBackground: "#1b5a33",
      black: "#07110a",
      red: "#ff6a6a",
      green: "#b8ffd0",
      yellow: "#d7ffa8",
      blue: "#3fbf6b",
      magenta: "#e6b3ff",
      cyan: "#c9a0ff",
      white: "#5cf08a",
      brightBlack: "#2e7a4a",
      brightRed: "#ff8f8f",
      brightGreen: "#d9ffe6",
      brightYellow: "#ecffc8",
      brightBlue: "#66d98f",
      brightMagenta: "#f2d6ff",
      brightCyan: "#dcc0ff",
      brightWhite: "#d9ffe6",
    },
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
