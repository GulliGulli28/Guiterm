import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface ShortcutAction {
  id: string;
  label: string;
  defaultKey: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "palette.open", label: "Ouvrir la palette de commandes", defaultKey: "Ctrl+K" },
  { id: "sidebar.toggle", label: "Afficher/masquer la barre latérale", defaultKey: "Ctrl+B" },
  { id: "split.toggle", label: "Activer/désactiver le mode split", defaultKey: "Ctrl+\\" },
  { id: "tab.close", label: "Fermer l'onglet actif", defaultKey: "Ctrl+Shift+W" },
  { id: "tab.newLocalTerminal", label: "Nouveau terminal local", defaultKey: "Ctrl+T" },
  { id: "tab.next", label: "Onglet suivant", defaultKey: "Ctrl+Tab" },
  { id: "tab.prev", label: "Onglet précédent", defaultKey: "Ctrl+Shift+Tab" },
  { id: "settings.open", label: "Ouvrir les paramètres", defaultKey: "Ctrl+," },
  { id: "snippets.quickRun", label: "Exécuter un snippet…", defaultKey: "Ctrl+Shift+R" },
];

export function defaultShortcuts(): Record<string, string> {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultKey]));
}

// Combos that collide with very common shell/readline key bindings — rebinding a
// shortcut to one of these is legal but means the app-level action will normally
// only fire outside a terminal (since xterm consumes and swallows the key first).
const SHELL_BINDING_WARNINGS: Record<string, string> = {
  "Ctrl+W": "supprime le mot précédent dans la plupart des shells (readline)",
  "Ctrl+K": "supprime jusqu'à la fin de la ligne (kill-line)",
  "Ctrl+U": "supprime jusqu'au début de la ligne",
  "Ctrl+R": "recherche dans l'historique des commandes",
  "Ctrl+A": "place le curseur en début de ligne",
  "Ctrl+E": "place le curseur en fin de ligne",
  "Ctrl+D": "envoie EOF / ferme le shell",
  "Ctrl+C": "interrompt le processus en cours (SIGINT)",
  "Ctrl+Z": "suspend le processus en cours (SIGTSTP)",
  "Ctrl+L": "efface l'écran",
  "Ctrl+\\": "quitte le processus en cours (SIGQUIT)",
  "Ctrl+T": "transpose les deux caractères précédents",
  "Ctrl+B": "recule le curseur d'un caractère",
};

/** Returns a human-readable warning if `combo` collides with a common shell binding, else `undefined`. */
export function shellBindingWarning(combo: string): string | undefined {
  return SHELL_BINDING_WARNINGS[combo];
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Renders a `KeyboardEvent` as a combo string like `"Ctrl+Shift+K"`, matching the format used to store/display shortcuts. */
export function comboFromEvent(e: KeyboardEvent | ReactKeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (!MODIFIER_KEYS.has(e.key)) parts.push(normalizeKey(e.key));
  return parts.join("+");
}

export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  return !!combo && comboFromEvent(e) === combo;
}

// Shortcuts whose default combos don't collide with common shell bindings, so it's
// safe to always let them bubble past xterm's own key handling up to the window-level
// listener — otherwise xterm consumes and stops propagation of every key it processes,
// so these would only ever fire when focus happens to be outside a terminal.
const BUBBLE_THROUGH_TERMINAL_ACTIONS = ["tab.next", "tab.prev", "tab.close", "snippets.quickRun"];

/** Whether `e` matches one of the app shortcuts that should bypass xterm's own key handling. */
export function shouldBubbleToShortcut(e: KeyboardEvent, shortcuts: Record<string, string>): boolean {
  return BUBBLE_THROUGH_TERMINAL_ACTIONS.some((id) => matchesCombo(e, shortcuts[id]));
}

/**
 * Attaches one window-level keydown listener that dispatches to `handlers` based on
 * `shortcuts` (action id -> combo string, e.g. from `AppPreferences.keyboardShortcuts`).
 * Elements that need to capture raw keys themselves (e.g. a shortcut-rebind input, or
 * xterm's own key handling) should `stopPropagation` so they never reach this listener.
 */
export function useGlobalShortcuts(shortcuts: Record<string, string>, handlers: Record<string, (() => void) | undefined>) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const [id, combo] of Object.entries(shortcuts)) {
        if (matchesCombo(e, combo)) {
          const handler = handlers[id];
          if (handler) {
            e.preventDefault();
            handler();
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, handlers]);
}
