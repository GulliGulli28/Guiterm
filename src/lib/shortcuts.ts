import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface ShortcutAction {
  id: string;
  label: string;
  defaultKey: string;
  /** Let this combo past xterm's own key handling, up to the window listener.
   *
   * xterm calls `stopPropagation()` on every key it processes, so an action
   * without this **never fires while a terminal has focus** — which is most of
   * the time. It used to live in a separate array that had to be kept in step
   * by hand; a new shortcut left out of it simply didn't work, silently, and
   * nothing failed. Declaring it on the action is what makes forgetting
   * impossible.
   *
   * Off by default because it isn't free: a combo that bubbles is one the
   * shell can no longer receive. */
  bubblesThroughTerminal?: true;
  /** Keep this action out of the command palette.
   *
   * Only for actions whose palette entry would be noise: "go to tab 4" is nine
   * near-identical rows in a list people scan by reading. They stay in the
   * settings list, where rebinding them is the whole point. */
  paletteHidden?: true;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "palette.open", label: "Ouvrir la palette de commandes", defaultKey: "Ctrl+K" },
  { id: "sidebar.toggle", label: "Afficher/masquer la barre latérale", defaultKey: "Ctrl+B" },
  { id: "split.toggle", label: "Activer/désactiver le mode split", defaultKey: "Ctrl+\\" },
  { id: "tab.close", label: "Fermer l'onglet actif", defaultKey: "Ctrl+Shift+W", bubblesThroughTerminal: true },
  { id: "tab.newLocalTerminal", label: "Nouveau terminal local", defaultKey: "Ctrl+T" },
  { id: "tab.next", label: "Onglet suivant", defaultKey: "Ctrl+Tab", bubblesThroughTerminal: true },
  { id: "tab.prev", label: "Onglet précédent", defaultKey: "Ctrl+Shift+Tab", bubblesThroughTerminal: true },
  { id: "settings.open", label: "Ouvrir les paramètres", defaultKey: "Ctrl+," },
  { id: "snippets.quickRun", label: "Exécuter un snippet…", defaultKey: "Ctrl+Shift+R", bubblesThroughTerminal: true },
  { id: "window.fullscreen", label: "Mode plein écran", defaultKey: "F11", bubblesThroughTerminal: true },

  // Direct tab access. Until now the only way across was Ctrl+Tab, one step at
  // a time — fine with three tabs, useless with a dozen. `Ctrl+9` goes to the
  // *last* tab rather than the ninth, the convention every browser uses.
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto${i + 1}`,
    label: i === 8 ? "Aller au dernier onglet" : `Aller à l'onglet ${i + 1}`,
    defaultKey: `Ctrl+${i + 1}`,
    bubblesThroughTerminal: true as const,
    paletteHidden: true as const,
  })),

  // Acting on the session you're looking at. All three were reachable only
  // through the palette or the mouse, which is backwards for things you do
  // *while* typing in a terminal — hence all three bubbling.
  { id: "tab.reconnect", label: "Reconnecter l'onglet actif", defaultKey: "Ctrl+Shift+E", bubblesThroughTerminal: true },
  // Hidden from the palette, which deliberately offers "Enregistrer" and
  // "Arrêter l'enregistrement" as two separate rows: a list read at a glance
  // shouldn't say "Enregistrer" when it would in fact stop. Both rows carry
  // this combo as their hint, so the shortcut is still discoverable there.
  { id: "terminal.toggleRecording", label: "Enregistrer / arrêter l'enregistrement de la session", defaultKey: "Ctrl+Shift+S", bubblesThroughTerminal: true, paletteHidden: true },
  { id: "terminal.exportScrollback", label: "Exporter le scrollback du terminal actif…", defaultKey: "Ctrl+Shift+X", bubblesThroughTerminal: true },

  // Tool tabs and panels.
  { id: "fleet.open", label: "Opérations de flotte — exécuter sur plusieurs hôtes…", defaultKey: "Ctrl+Shift+O", bubblesThroughTerminal: true },
  { id: "activity.open", label: "Activité — qui a fait quoi, où, quand…", defaultKey: "Ctrl+Shift+A", bubblesThroughTerminal: true },
  { id: "database.open", label: "Bases de données", defaultKey: "Ctrl+Shift+Q", bubblesThroughTerminal: true },
  { id: "netdiag.open", label: "Diagnostic réseau — ping, DNS, TCP, HTTP…", defaultKey: "Ctrl+Shift+D", bubblesThroughTerminal: true },

  // Broadcast is turned *off* from inside a terminal as often as it is turned
  // on — a shortcut that only worked outside one would miss half its use.
  { id: "broadcast.toggle", label: "Activer/couper la diffusion", defaultKey: "Ctrl+Shift+B", bubblesThroughTerminal: true },
  { id: "host.new", label: "Nouvel hôte…", defaultKey: "Ctrl+Shift+N", bubblesThroughTerminal: true },
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

/** The digit on the physical key, from `KeyboardEvent.code`, or `null`.
 *
 * **Read from the physical key rather than the character, because of AZERTY.**
 * On a French layout the number row is `&é"'(-è_ç` unshifted; the digits need
 * Shift. So `e.key` for the "1" key is either `"&"` or `"1"` depending on a
 * modifier the user didn't mean as one, and a `Ctrl+1` shortcut would be
 * unreachable — `Ctrl+Shift+1` is what would actually arrive. `e.code` is
 * `Digit1` on every layout.
 */
function digitFromCode(code: string | undefined): string | null {
  const match = /^(?:Digit|Numpad)(\d)$/.exec(code ?? "");
  return match ? match[1] : null;
}

/** Renders a `KeyboardEvent` as a combo string like `"Ctrl+Shift+K"`, matching the format used to store/display shortcuts. */
export function comboFromEvent(e: KeyboardEvent | ReactKeyboardEvent): string {
  const digit = digitFromCode(e.code);
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  // Shift is deliberately dropped on the digit row. It is what a French layout
  // requires just to *produce* a digit, so counting it would make `Ctrl+1`
  // untypable there — while on QWERTY, where it isn't needed, nothing binds
  // `Ctrl+Shift+<digit>` anyway. The upshot is that both `Ctrl+1` and
  // `Ctrl+&` (the same physical key) reach the first tab.
  if (e.shiftKey && !digit) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (digit) parts.push(digit);
  else if (!MODIFIER_KEYS.has(e.key)) parts.push(normalizeKey(e.key));
  return parts.join("+");
}

export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  return !!combo && comboFromEvent(e) === combo;
}

/** Action ids that must reach the window listener even from inside a terminal.
 *
 * Derived from {@link SHORTCUT_ACTIONS} rather than listed separately: the two
 * used to be maintained by hand, and a shortcut missing from the list didn't
 * work in a terminal with nothing to show for it. */
const BUBBLE_THROUGH_TERMINAL_ACTIONS = SHORTCUT_ACTIONS
  .filter((a) => a.bubblesThroughTerminal)
  .map((a) => a.id);

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
