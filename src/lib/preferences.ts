import type { ITheme } from "@xterm/xterm";
import type { SidebarButtonId } from "./sidebarButtons";
import { defaultShortcuts } from "./shortcuts";

export type UiAccent = "indigo" | "blue" | "violet" | "emerald" | "rose" | "teal" | "amber" | "cyan";

export interface AccentColorEntry {
  label: string;
  c600: string;
  c500: string;
  c300: string;
  dim: string;
}

export const ACCENT_COLORS: Record<UiAccent, AccentColorEntry> = {
  indigo:  { label: "Indigo",   c600: "#4f46e5", c500: "#6366f1", c300: "#a5b4fc", dim: "rgba(79,70,229,0.18)"  },
  blue:    { label: "Bleu",     c600: "#2563eb", c500: "#3b82f6", c300: "#93c5fd", dim: "rgba(37,99,235,0.18)"  },
  violet:  { label: "Violet",   c600: "#7c3aed", c500: "#8b5cf6", c300: "#c4b5fd", dim: "rgba(124,58,237,0.18)" },
  emerald: { label: "Émeraude", c600: "#059669", c500: "#10b981", c300: "#6ee7b7", dim: "rgba(5,150,105,0.18)"  },
  rose:    { label: "Rose",     c600: "#e11d48", c500: "#f43f5e", c300: "#fda4af", dim: "rgba(225,29,72,0.18)"  },
  teal:    { label: "Teal",     c600: "#0d9488", c500: "#14b8a6", c300: "#5eead4", dim: "rgba(13,148,136,0.18)" },
  amber:   { label: "Ambre",    c600: "#d97706", c500: "#f59e0b", c300: "#fcd34d", dim: "rgba(217,119,6,0.18)"  },
  cyan:    { label: "Cyan",     c600: "#0891b2", c500: "#06b6d4", c300: "#67e8f9", dim: "rgba(8,145,178,0.18)"  },
};

export type UiBg = "slate" | "gray" | "zinc" | "black" | "navy" | "aurora";
export type ColorMode = "dark" | "light";

export interface BgShade {
  bg: string;
  bg2: string;
  bg3: string;
  border: string;
}

export interface BgThemeEntry {
  label: string;
  dark: BgShade;
  light: BgShade;
}

export const BG_THEMES: Record<UiBg, BgThemeEntry> = {
  slate: {
    label: "Ardoise",
    dark:  { bg: "#020617", bg2: "#0f172a", bg3: "#1e293b", border: "#1e293b" },
    light: { bg: "#f8fafc", bg2: "#f1f5f9", bg3: "#e2e8f0", border: "#cbd5e1" },
  },
  gray: {
    label: "Gris",
    dark:  { bg: "#030712", bg2: "#111827", bg3: "#1f2937", border: "#1f2937" },
    light: { bg: "#f9fafb", bg2: "#f3f4f6", bg3: "#e5e7eb", border: "#d1d5db" },
  },
  zinc: {
    label: "Zinc",
    dark:  { bg: "#09090b", bg2: "#18181b", bg3: "#27272a", border: "#27272a" },
    light: { bg: "#fafafa", bg2: "#f4f4f5", bg3: "#e4e4e7", border: "#d4d4d8" },
  },
  black: {
    label: "Noir pur",
    dark:  { bg: "#000000", bg2: "#0d0d0d", bg3: "#1a1a1a", border: "#262626" },
    light: { bg: "#ffffff", bg2: "#f5f5f5", bg3: "#ebebeb", border: "#d9d9d9" },
  },
  navy: {
    label: "Marine",
    dark:  { bg: "#020c1b", bg2: "#0d1b2e", bg3: "#1a3148", border: "#1e3a52" },
    light: { bg: "#f0f4f8", bg2: "#e1e9f0", bg3: "#cdd9e5", border: "#b8c9da" },
  },
  aurora: {
    label: "Aurora",
    dark:  { bg: "#08070d", bg2: "#0d0b14", bg3: "#17131f", border: "#231e30" },
    light: { bg: "#f8f6fc", bg2: "#f0ecf8", bg3: "#e3dcf1", border: "#cec2e3" },
  },
};

export interface AppPreferences {
  terminalThemeName: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  sftpFontSize: number;
  /** Afficher les fichiers commençant par un point dans les panneaux de
   * transfert. Vrai par défaut : c'est le comportement qui existait avant que
   * la bascule existe, et un client SSH sert précisément souvent à aller
   * chercher un `.env` ou un `.ssh/`. */
  sftpShowHidden: boolean;
  /** Affichage de la comparaison de deux fichiers : `unified` met les deux
   * versions l'une sous l'autre, `split` les met côte à côte. Retenu d'une
   * fois sur l'autre — c'est une habitude de lecture, pas un choix par
   * fichier. */
  transferDiffView: "unified" | "split";
  uiAccent: UiAccent;
  uiBg: UiBg;
  colorMode: ColorMode;
  notifyOnDisconnect: boolean;
  notifyOnTransferDone: boolean;
  notifyOnUpdateAvailable: boolean;
  keyboardShortcuts: Record<string, string>;
  restoreTabsOnLaunch: boolean;
  /** Rouvrir *tout seul*, au lancement, les onglets restaurés qui portent une
   * session persistante (`termius_core::persistent_shell`) — les autres
   * restent des vignettes à cliquer, comme avant.
   *
   * Désactivé par défaut, et il faut que ça le reste : l'app ne se connecte à
   * rien au lancement, et se mettre à ouvrir des connexions SSH sans qu'on
   * l'ait demandé changerait ce contrat pour tout le monde. Restreint aux
   * onglets persistants parce que ce sont les seuls où l'ouverture rend
   * quelque chose (l'écran laissé) plutôt qu'un shell vierge. */
  resumePersistentTabsOnLaunch: boolean;
  terminalRightClickMenu: boolean;
  autoReconnect: boolean;
  autoReconnectMaxAttempts: number;
  /** Notify when a command that ran at least this many seconds finishes while
   * this window doesn't have focus. `0` turns it off. Detection is a
   * heuristic — see `lib/longCommand.ts` for exactly what it can and can't
   * tell apart. */
  longCommandNotifySecs: number;
  /** Shell id (from `api.listLocalShells`) used for new local terminals; `null` = system default. */
  defaultLocalShell: string | null;
  /** Ghost-text command suggestions (based on local history) in local terminals only. */
  localTerminalSuggestions: boolean;
  /** Same ghost-text suggestions, but for SSH terminals (history shared across all hosts). Off by default: network latency and remote-shell quirks make it less predictable than the local version. */
  sshTerminalSuggestions: boolean;
  /** Minutes of inactivity after which the master-password vault auto-locks. `0` = never. Only relevant when a master password is set. */
  masterVaultAutoLockMinutes: number;
  /** Renders the terminal through xterm's WebGL renderer instead of its DOM
   * one. On by default, but exposed as a setting rather than hardcoded
   * because which one wins genuinely depends on the machine: the WebGL
   * renderer draws from a glyph atlas on the GPU, so it should stay ahead
   * under sustained output — but on a system with no usable hardware
   * acceleration it is markedly *slower* than the DOM renderer, which xterm
   * has optimised heavily (it only ever mounts the visible viewport).
   * `scripts/bench-terminal-render.mjs` measures the two, and could not
   * settle it for real hardware: no GPU is available in a headless or WSLg
   * Chromium. Falls back to the DOM renderer on its own if WebGL is
   * unavailable, so turning this on can't break a terminal. */
  terminalWebglRenderer: boolean;
  /** Overlays a live ms/frame readout on each terminal — the point of
   * `terminalWebglRenderer` being a setting is being able to compare the two
   * on your own hardware, which needs something to compare with. */
  terminalRenderStats: boolean;
  /** Boutons retirés de la barre verticale de gauche. Liste de **masqués**, et
   * non d'affichés, délibérément : ces préférences vivent dans le
   * `localStorage` de la webview, donc une installation déjà utilisée n'hérite
   * jamais d'un défaut modifié. Une liste d'affichés serait absente chez tous
   * les utilisateurs actuels — et leur viderait la barre à la mise à jour. */
  hiddenSidebarButtons: SidebarButtonId[];
}

export interface TerminalThemeEntry {
  label: string;
  theme: ITheme;
}

export const TERMINAL_THEMES: Record<string, TerminalThemeEntry> = {
  dark: {
    label: "Dark (par défaut)",
    theme: {
      background: "#020617", foreground: "#e2e8f0", cursor: "#a5b4fc",
      selectionBackground: "#1e293b",
      black: "#0f172a", brightBlack: "#334155",
      red: "#ef4444", brightRed: "#f87171",
      green: "#22c55e", brightGreen: "#4ade80",
      yellow: "#eab308", brightYellow: "#facc15",
      blue: "#3b82f6", brightBlue: "#60a5fa",
      magenta: "#a855f7", brightMagenta: "#c084fc",
      cyan: "#06b6d4", brightCyan: "#22d3ee",
      white: "#e2e8f0", brightWhite: "#f8fafc",
    },
  },
  dracula: {
    label: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c", brightBlack: "#6272a4",
      red: "#ff5555", brightRed: "#ff6e6e",
      green: "#50fa7b", brightGreen: "#69ff94",
      yellow: "#f1fa8c", brightYellow: "#ffffa5",
      blue: "#bd93f9", brightBlue: "#d6acff",
      magenta: "#ff79c6", brightMagenta: "#ff92df",
      cyan: "#8be9fd", brightCyan: "#a4ffff",
      white: "#f8f8f2", brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496", cursor: "#839496",
      selectionBackground: "#073642",
      black: "#073642", brightBlack: "#586e75",
      red: "#dc322f", brightRed: "#cb4b16",
      green: "#859900", brightGreen: "#859900",
      yellow: "#b58900", brightYellow: "#657b83",
      blue: "#268bd2", brightBlue: "#839496",
      magenta: "#d33682", brightMagenta: "#6c71c4",
      cyan: "#2aa198", brightCyan: "#93a1a1",
      white: "#eee8d5", brightWhite: "#fdf6e3",
    },
  },
  monokai: {
    label: "Monokai",
    theme: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
      selectionBackground: "#49483e",
      black: "#272822", brightBlack: "#75715e",
      red: "#f92672", brightRed: "#f92672",
      green: "#a6e22e", brightGreen: "#a6e22e",
      yellow: "#f4bf75", brightYellow: "#f4bf75",
      blue: "#66d9e8", brightBlue: "#66d9e8",
      magenta: "#ae81ff", brightMagenta: "#ae81ff",
      cyan: "#a1efe4", brightCyan: "#a1efe4",
      white: "#f8f8f2", brightWhite: "#f9f8f5",
    },
  },
  "one-dark": {
    label: "One Dark",
    theme: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#282c34", brightBlack: "#545862",
      red: "#e06c75", brightRed: "#e06c75",
      green: "#98c379", brightGreen: "#98c379",
      yellow: "#e5c07b", brightYellow: "#e5c07b",
      blue: "#61afef", brightBlue: "#61afef",
      magenta: "#c678dd", brightMagenta: "#c678dd",
      cyan: "#56b6c2", brightCyan: "#56b6c2",
      white: "#abb2bf", brightWhite: "#ffffff",
    },
  },
  nord: {
    label: "Nord",
    theme: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252", brightBlack: "#4c566a",
      red: "#bf616a", brightRed: "#bf616a",
      green: "#a3be8c", brightGreen: "#a3be8c",
      yellow: "#ebcb8b", brightYellow: "#ebcb8b",
      blue: "#81a1c1", brightBlue: "#81a1c1",
      magenta: "#b48ead", brightMagenta: "#b48ead",
      cyan: "#88c0d0", brightCyan: "#8fbcbb",
      white: "#e5e9f0", brightWhite: "#eceff4",
    },
  },
  gruvbox: {
    label: "Gruvbox Dark",
    theme: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2",
      selectionBackground: "#3c3836",
      black: "#282828", brightBlack: "#928374",
      red: "#cc241d", brightRed: "#fb4934",
      green: "#98971a", brightGreen: "#b8bb26",
      yellow: "#d79921", brightYellow: "#fabd2f",
      blue: "#458588", brightBlue: "#83a598",
      magenta: "#b16286", brightMagenta: "#d3869b",
      cyan: "#689d6a", brightCyan: "#8ec07c",
      white: "#a89984", brightWhite: "#ebdbb2",
    },
  },
  "ayu-dark": {
    label: "Ayu Dark",
    theme: {
      background: "#0a0e14", foreground: "#b3b1ad", cursor: "#e6b450",
      selectionBackground: "#253340",
      black: "#01060e", brightBlack: "#545f6e",
      red: "#ea6c73", brightRed: "#f28779",
      green: "#91b362", brightGreen: "#c2d94c",
      yellow: "#f9af4f", brightYellow: "#ffb454",
      blue: "#53bdfa", brightBlue: "#59c2ff",
      magenta: "#fae994", brightMagenta: "#ffee99",
      cyan: "#90e1c6", brightCyan: "#95e6cb",
      white: "#c7c7c7", brightWhite: "#ffffff",
    },
  },
};

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "ui-monospace, SFMono-Regular, Menlo, monospace", label: "Monospace (système)" },
  { value: "Consolas, monospace", label: "Consolas" },
  { value: "\"JetBrains Mono\", monospace", label: "JetBrains Mono" },
  { value: "\"Fira Code\", monospace", label: "Fira Code" },
  { value: "\"Cascadia Code\", monospace", label: "Cascadia Code" },
  { value: "\"Source Code Pro\", monospace", label: "Source Code Pro" },
  { value: "\"Ubuntu Mono\", monospace", label: "Ubuntu Mono" },
  { value: "\"Courier New\", monospace", label: "Courier New" },
];

export const DEFAULT_PREFERENCES: AppPreferences = {
  terminalThemeName: "dark",
  terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  terminalFontSize: 14,
  sftpFontSize: 13,
  sftpShowHidden: true,
  transferDiffView: "unified",
  uiAccent: "violet",
  uiBg: "aurora",
  colorMode: "dark",
  notifyOnDisconnect: true,
  notifyOnTransferDone: true,
  notifyOnUpdateAvailable: true,
  keyboardShortcuts: defaultShortcuts(),
  restoreTabsOnLaunch: true,
  resumePersistentTabsOnLaunch: false,
  terminalRightClickMenu: true,
  autoReconnect: false,
  autoReconnectMaxAttempts: 5,
  longCommandNotifySecs: 20,
  defaultLocalShell: null,
  localTerminalSuggestions: true,
  sshTerminalSuggestions: false,
  masterVaultAutoLockMinutes: 0,
  terminalWebglRenderer: true,
  terminalRenderStats: false,
  hiddenSidebarButtons: [],
};

// Same two-stop aurora wash as `.app-aurora-bg` in index.css, but layered over
// a caller-supplied base color instead of `--c-bg` — lets the terminal panel
// keep its own theme color (Dracula, Nord, …) while still showing the glow
// around the edges instead of a flat opaque rectangle.
export function auroraLayerBackground(baseColor: string): string {
  return `radial-gradient(1100px 550px at 12% -12%, color-mix(in srgb, var(--c-accent) 14%, transparent), transparent 60%), radial-gradient(700px 380px at 92% -6%, color-mix(in srgb, var(--c-accent) 8%, transparent), transparent 55%), ${baseColor}`;
}

const STORAGE_KEY = "gui-termius-prefs";

export function loadPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_PREFERENCES,
        ...parsed,
        keyboardShortcuts: { ...DEFAULT_PREFERENCES.keyboardShortcuts, ...(parsed.keyboardShortcuts ?? {}) },
        // Toute la barre latérale se rend à partir de cette liste : si un
        // `localStorage` édité à la main y met autre chose qu'un tableau,
        // l'app entière n'affiche plus rien plutôt qu'un bouton de trop.
        hiddenSidebarButtons: Array.isArray(parsed.hiddenSidebarButtons) ? parsed.hiddenSidebarButtons : [],
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFERENCES };
}

export function savePreferences(prefs: AppPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
