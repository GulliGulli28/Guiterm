import type { ITheme } from "@xterm/xterm";
import type { SidebarButtonId } from "./sidebarButtons";
import { defaultShortcuts } from "./shortcuts";

export type UiAccent = "indigo" | "blue" | "violet" | "emerald" | "rose" | "teal" | "amber" | "cyan";
/** Une couleur nommée, ou la couleur libre de `uiAccentCustom`. */
export type UiAccentChoice = UiAccent | "custom";

export interface AccentColorEntry {
  label: string;
  /** Remplissage (bouton primaire, marqueur actif). */
  c600: string;
  /** Survol du remplissage — et la pastille de couleur d'un dossier. */
  c500: string;
  /** Texte accentué sur fond sombre. En clair, c'est `c600` qui sert : `c300`
   * n'a pas assez de contraste sur du blanc. */
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
  /** Quand le fond clair a sa teinte propre (« Noir pur » → « Blanc pur »). */
  lightLabel?: string;
  dark: BgShade;
  light: BgShade;
}

/* Quatre tons par famille, proches les uns des autres : la fenêtre (`bg`),
 * les panneaux (`bg2`), les contrôles et cartes (`bg3`), et la bordure. Un
 * écart trop grand entre `bg` et `bg2` faisait lire l'interface comme des
 * couches empilées ; ici, c'est la bordure d'un pixel qui découpe. En clair,
 * `bg2` est blanc — le panneau — et `bg` un gris à peine teinté pour la zone
 * de travail. */
export const BG_THEMES: Record<UiBg, BgThemeEntry> = {
  slate: {
    label: "Ardoise",
    dark:  { bg: "#0a0e17", bg2: "#10151f", bg3: "#171d2a", border: "#232b3b" },
    light: { bg: "#e9eef5", bg2: "#f8fafc", bg3: "#e2e8f0", border: "#c9d3e0" },
  },
  gray: {
    label: "Gris",
    dark:  { bg: "#0b0d12", bg2: "#111318", bg3: "#181b22", border: "#242830" },
    light: { bg: "#ececee", bg2: "#f9f9fa", bg3: "#e3e3e6", border: "#cfcfd4" },
  },
  zinc: {
    label: "Zinc",
    lightLabel: "Sable",
    dark:  { bg: "#0c0c0e", bg2: "#121215", bg3: "#19191d", border: "#26262b" },
    light: { bg: "#f0eee9", bg2: "#fbfaf7", bg3: "#e8e5de", border: "#d6d2c8" },
  },
  black: {
    label: "Noir pur",
    lightLabel: "Blanc pur",
    dark:  { bg: "#000000", bg2: "#0a0a0a", bg3: "#141414", border: "#222222" },
    light: { bg: "#ffffff", bg2: "#ffffff", bg3: "#f2f2f2", border: "#e2e2e2" },
  },
  navy: {
    label: "Marine",
    lightLabel: "Ciel",
    dark:  { bg: "#060d1a", bg2: "#0b1526", bg3: "#122036", border: "#1c2d47" },
    light: { bg: "#e3ebf6", bg2: "#f4f7fc", bg3: "#d9e3f0", border: "#bfcde0" },
  },
  aurora: {
    label: "Prune",
    lightLabel: "Lavande",
    dark:  { bg: "#0b0910", bg2: "#110e17", bg3: "#191420", border: "#26202f" },
    light: { bg: "#ede8f5", bg2: "#f9f7fc", bg3: "#e4dcef", border: "#cdc2df" },
  },
};

/** Le nom d'un fond tel qu'il se présente dans le mode courant : les fonds
 * clairs ne sont pas les fonds sombres éclaircis, ils ont leur teinte propre
 * et donc leur nom. */
export function bgThemeLabel(entry: BgThemeEntry, mode: ColorMode): string {
  return mode === "light" ? entry.lightLabel ?? entry.label : entry.label;
}

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
  uiAccent: UiAccentChoice;
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
  /** Masquer la barre d'état de tmux dans les sessions persistantes.
   *
   * Activé par défaut : la fonctionnalité se présente comme « des sessions qui
   * survivent », pas comme « tmux », et une barre verte inattendue en bas d'un
   * terminal ressemble à un bug. Le revers est réel — c'est elle qui montre les
   * fenêtres tmux si on en ouvre plusieurs (`Ctrl+B c`) —, d'où le réglage.
   *
   * Appliqué à chaque rattachement, donc changer d'avis vaut pour les sessions
   * déjà ouvertes. Ne pas masquer ne veut pas dire afficher de force : l'option
   * est rendue à ce dont elle hérite, donc au `.tmux.conf` de l'utilisateur. */
  tmuxHideStatusBar: boolean;
  /** Laisser tmux recevoir la souris dans les sessions persistantes.
   *
   * Activé par défaut, parce que c'est ce qui rend la molette utile : tmux
   * repeint l'écran entier à chaque rafraîchissement, donc le tampon de
   * défilement de xterm reste vide et l'historique vit **dans** tmux — seul
   * son mode copie y donne accès, et la molette est ce qui l'ouvre.
   *
   * Le revers, à dire dans le réglage : quand une application capte la souris,
   * sélectionner du texte demande de maintenir Maj. */
  tmuxMouseMode: boolean;
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
  /** Taille de police, en pixels, des lignes de dossier dans les
   * arborescences (hôtes, SFTP, cibles) — l'icône et la hauteur de ligne en
   * découlent (`hostGroupMetrics`). Une préférence de lecture : quelqu'un qui
   * range trente machines en cinq dossiers veut des en-têtes qui se voient,
   * quelqu'un qui en a deux les veut discrets. */
  hostGroupSize: number;
  /** Taille, en pixels, de l'icône des lignes de dossier — réglée à part de
   * la police : on veut parfois un gros pictogramme devant un petit nom. */
  hostGroupIconSize: number;
  /** Taille de police, en pixels, du nom d'une ligne d'hôte (et de toute
   * ligne d'entité : clés, bases, tunnels…) ; la ligne secondaire en découle. */
  hostRowSize: number;
  /** Taille, en pixels, de l'icône d'une ligne d'hôte. */
  hostRowIconSize: number;
  /** Police des panneaux de transfert. `"inherit"` = celle de l'interface ;
   * une chasse fixe y est un choix courant (les noms de fichiers s'alignent). */
  sftpFontFamily: string;
  /** Couleur d'accent libre, en hexadécimal, quand `uiAccent` vaut
   * `"custom"`. Les huit couleurs nommées restent des raccourcis. */
  uiAccentCustom: string;
  /** Police de l'interface (pas celle du terminal). Une valeur de
   * `UI_FONT_FAMILIES`. */
  uiFontFamily: string;
}

export const HOST_GROUP_SIZE_MIN = 11;
export const HOST_GROUP_SIZE_MAX = 20;
export const HOST_GROUP_ICON_MIN = 12;
export const HOST_GROUP_ICON_MAX = 32;
export const HOST_ROW_SIZE_MIN = 11;
export const HOST_ROW_SIZE_MAX = 18;
export const HOST_ROW_ICON_MIN = 12;
export const HOST_ROW_ICON_MAX = 32;

/** Ce que les deux tailles de ligne d'hôte posent comme variables CSS — lues
 * par `EntityRow`. La ligne secondaire (adresse, tags) reste un cran sous le
 * nom, l'icône a sa boîte à elle. */
export function hostRowMetrics(fontPx: number, iconPx: number): { font: string; sub: string; icon: string } {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v * 2) / 2));
  const font = clamp(fontPx, HOST_ROW_SIZE_MIN, HOST_ROW_SIZE_MAX);
  const icon = clamp(iconPx, HOST_ROW_ICON_MIN, HOST_ROW_ICON_MAX);
  return { font: `${font}px`, sub: `${Math.max(10, Math.round((font - 2) * 2) / 2)}px`, icon: `${icon}px` };
}

/** Ce que les deux tailles de dossier posent comme variables CSS — lues par
 * `GroupRow`. La ligne est aussi haute que le plus grand des deux, avec de
 * l'air autour. */
export function hostGroupMetrics(fontPx: number, iconPx: number): { font: string; icon: string; height: string } {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v * 2) / 2));
  const font = clamp(fontPx, HOST_GROUP_SIZE_MIN, HOST_GROUP_SIZE_MAX);
  const icon = clamp(iconPx, HOST_GROUP_ICON_MIN, HOST_GROUP_ICON_MAX);
  return { font: `${font}px`, icon: `${icon}px`, height: `${Math.round(Math.max(font * 2.2, icon + 10))}px` };
}

export const UI_FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "system", label: "Système (Segoe UI sous Windows)" },
  { value: "\"Inter\", system-ui, sans-serif", label: "Inter" },
  { value: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif", label: "Segoe UI" },
  { value: "\"Helvetica Neue\", Helvetica, Arial, sans-serif", label: "Helvetica / Arial" },
  { value: "Verdana, Geneva, sans-serif", label: "Verdana" },
  { value: "\"JetBrains Mono\", ui-monospace, monospace", label: "JetBrains Mono (tout en mono)" },
];

/** La pile de polices réellement appliquée pour une valeur de `uiFontFamily`.
 * `"system"` est la valeur par défaut, laissée au navigateur. */
export function uiFontStack(value: string): string {
  return value === "system"
    ? "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    : value;
}

/** La police des panneaux de transfert : `"inherit"` suit l'interface. */
export function sftpFontStack(value: string | undefined): string | undefined {
  return !value || value === "inherit" ? undefined : value;
}

/** Les quatre teintes d'accent dérivées d'une couleur libre : remplissage,
 * survol (un peu plus clair), texte sur fond sombre (nettement plus clair),
 * et le voile atténué. */
export function accentFromHex(hex: string): AccentColorEntry {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x2563eb;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (t: number) => "#" + [r, g, b].map((c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0")).join("");
  return { label: "Personnalisée", c600: mix(0), c500: mix(0.12), c300: mix(0.45), dim: `rgba(${r},${g},${b},0.18)` };
}

export interface TerminalThemeEntry {
  label: string;
  theme: ITheme;
}

export const TERMINAL_THEMES: Record<string, TerminalThemeEntry> = {
  dark: {
    label: "Sombre (par défaut)",
    theme: {
      background: "#0f0f12", foreground: "#e4e4e7", cursor: "#93c5fd",
      selectionBackground: "#2a2a33",
      black: "#18181b", brightBlack: "#52525b",
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
  light: {
    label: "Clair",
    theme: {
      background: "#fbfaf7", foreground: "#27272a", cursor: "#2563eb",
      selectionBackground: "#dbe4f3",
      black: "#3f3f46", brightBlack: "#71717a",
      red: "#c81e1e", brightRed: "#dc2626",
      green: "#15803d", brightGreen: "#16a34a",
      yellow: "#a16207", brightYellow: "#ca8a04",
      blue: "#1d4ed8", brightBlue: "#2563eb",
      magenta: "#7e22ce", brightMagenta: "#9333ea",
      cyan: "#0e7490", brightCyan: "#0891b2",
      white: "#e4e4e7", brightWhite: "#ffffff",
    },
  },
  solarizedLight: {
    label: "Solarized Light",
    theme: {
      background: "#fdf6e3", foreground: "#657b83", cursor: "#657b83",
      selectionBackground: "#eee8d5",
      black: "#073642", brightBlack: "#002b36",
      red: "#dc322f", brightRed: "#cb4b16",
      green: "#859900", brightGreen: "#586e75",
      yellow: "#b58900", brightYellow: "#657b83",
      blue: "#268bd2", brightBlue: "#839496",
      magenta: "#d33682", brightMagenta: "#6c71c4",
      cyan: "#2aa198", brightCyan: "#93a1a1",
      white: "#eee8d5", brightWhite: "#fdf6e3",
    },
  },
  githubLight: {
    label: "GitHub Light",
    theme: {
      background: "#ffffff", foreground: "#24292f", cursor: "#0969da",
      selectionBackground: "#ddf4ff",
      black: "#24292f", brightBlack: "#57606a",
      red: "#cf222e", brightRed: "#a40e26",
      green: "#116329", brightGreen: "#1a7f37",
      yellow: "#4d2d00", brightYellow: "#633c01",
      blue: "#0969da", brightBlue: "#218bff",
      magenta: "#8250df", brightMagenta: "#a475f9",
      cyan: "#1b7c83", brightCyan: "#3192aa",
      white: "#6e7781", brightWhite: "#8c959f",
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
  uiAccent: "blue",
  uiBg: "zinc",
  colorMode: "dark",
  notifyOnDisconnect: true,
  notifyOnTransferDone: true,
  notifyOnUpdateAvailable: true,
  keyboardShortcuts: defaultShortcuts(),
  restoreTabsOnLaunch: true,
  resumePersistentTabsOnLaunch: false,
  tmuxHideStatusBar: true,
  tmuxMouseMode: true,
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
  hostGroupSize: 13,
  hostGroupIconSize: 16,
  hostRowSize: 12.5,
  hostRowIconSize: 24,
  sftpFontFamily: "inherit",
  uiAccentCustom: "#2563eb",
  uiFontFamily: "system",
};

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
        // Était « petits / normaux / grands » le temps d'une version : ces
        // trois mots deviennent les pixels qu'ils valaient.
        hostGroupSize: typeof parsed.hostGroupSize === "number"
          ? parsed.hostGroupSize
          : ({ small: 11.5, medium: 13, large: 15 } as Record<string, number>)[parsed.hostGroupSize] ?? DEFAULT_PREFERENCES.hostGroupSize,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFERENCES };
}

export function savePreferences(prefs: AppPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
