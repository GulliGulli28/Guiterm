import { describe, expect, it } from "vitest";
import {
  SHORTCUT_ACTIONS,
  comboFromEvent,
  defaultShortcuts,
  matchesCombo,
  shellBindingWarning,
  shouldBubbleToShortcut,
} from "./shortcuts";

/** A keydown as the DOM would deliver it. `code` matters as much as `key`:
 * the digit row is read from the physical key, not from the character. */
function keydown(init: {
  key: string;
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? "",
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    metaKey: false,
  } as KeyboardEvent;
}

describe("le catalogue d'actions", () => {
  it("n'a pas deux actions du même id", () => {
    const ids = SHORTCUT_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** With two dozen actions, two of them claiming the same combo is an easy
   * slip — and a silent one: `useGlobalShortcuts` stops at the first match, so
   * the loser simply never fires and nothing says why. */
  it("n'a pas deux actions sur la même combinaison par défaut", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const action of SHORTCUT_ACTIONS) {
      const previous = seen.get(action.defaultKey);
      if (previous) clashes.push(`${action.defaultKey} : ${previous} et ${action.id}`);
      seen.set(action.defaultKey, action.id);
    }
    expect(clashes).toEqual([]);
  });

  it("donne une combinaison par défaut à chaque action", () => {
    const defaults = defaultShortcuts();
    for (const action of SHORTCUT_ACTIONS) {
      expect(defaults[action.id], `${action.id} sans défaut`).toBeTruthy();
    }
    expect(Object.keys(defaults).length).toBe(SHORTCUT_ACTIONS.length);
  });

  /** The invariant that makes `bubblesThroughTerminal` safe: a combo that
   * bypasses xterm is a combo the shell can no longer receive. Marking a
   * readline binding as bubbling would quietly break Ctrl+W or Ctrl+R for
   * everyone typing in a terminal. */
  it("ne fait jamais passer par-dessus le terminal une combinaison que le shell utilise", () => {
    const offenders = SHORTCUT_ACTIONS
      .filter((a) => a.bubblesThroughTerminal && shellBindingWarning(a.defaultKey))
      .map((a) => `${a.id} (${a.defaultKey} — ${shellBindingWarning(a.defaultKey)})`);
    expect(offenders).toEqual([]);
  });
});

describe("shouldBubbleToShortcut", () => {
  const shortcuts = defaultShortcuts();

  it("laisse passer les actions déclarées comme telles", () => {
    // Ctrl+Tab: onglet suivant, marqué bubblesThroughTerminal.
    expect(shouldBubbleToShortcut(keydown({ key: "Tab", ctrl: true }), shortcuts)).toBe(true);
  });

  it("ne laisse pas passer les autres", () => {
    // Ctrl+T ouvre un terminal local, mais transpose deux caractères dans un
    // shell : il doit rester au terminal quand un terminal a le focus.
    expect(shouldBubbleToShortcut(keydown({ key: "t", code: "KeyT", ctrl: true }), shortcuts)).toBe(false);
  });

  /** The regression this replaced a hand-kept array to prevent: a new action
   * that bubbles must be picked up from its own declaration, with no second
   * list to remember. */
  it("prend en compte les actions ajoutées sans liste à maintenir", () => {
    expect(shouldBubbleToShortcut(keydown({ key: "1", code: "Digit1", ctrl: true }), shortcuts)).toBe(true);
    expect(shouldBubbleToShortcut(keydown({ key: "B", code: "KeyB", ctrl: true, shift: true }), shortcuts)).toBe(true);
  });
});

describe("comboFromEvent sur la rangée des chiffres", () => {
  /** The AZERTY problem this exists for: on a French layout the "1" key gives
   * `&` unshifted and `1` shifted, so a combo built from the character alone
   * makes `Ctrl+1` unreachable — the user can only ever produce
   * `Ctrl+Shift+1`. Both spellings must land on the same shortcut. */
  it("rend Ctrl+1 quel que soit le clavier", () => {
    // QWERTY : la touche donne « 1 » directement.
    expect(comboFromEvent(keydown({ key: "1", code: "Digit1", ctrl: true }))).toBe("Ctrl+1");
    // AZERTY avec Shift, seule façon d'obtenir « 1 ».
    expect(comboFromEvent(keydown({ key: "1", code: "Digit1", ctrl: true, shift: true }))).toBe("Ctrl+1");
    // AZERTY sans Shift : la même touche physique donne « & ».
    expect(comboFromEvent(keydown({ key: "&", code: "Digit1", ctrl: true }))).toBe("Ctrl+1");
  });

  it("accepte aussi le pavé numérique", () => {
    expect(comboFromEvent(keydown({ key: "9", code: "Numpad9", ctrl: true }))).toBe("Ctrl+9");
  });

  it("les trois orthographes déclenchent bien le raccourci d'onglet", () => {
    const combo = defaultShortcuts()["tab.goto1"];
    expect(combo).toBe("Ctrl+1");
    for (const e of [
      keydown({ key: "1", code: "Digit1", ctrl: true }),
      keydown({ key: "1", code: "Digit1", ctrl: true, shift: true }),
      keydown({ key: "&", code: "Digit1", ctrl: true }),
    ]) {
      expect(matchesCombo(e, combo)).toBe(true);
    }
  });

  /** Shift is dropped only for digits — everywhere else it is part of the
   * combo, or Ctrl+Shift+W would collide with Ctrl+W. */
  it("garde Shift partout ailleurs", () => {
    expect(comboFromEvent(keydown({ key: "W", code: "KeyW", ctrl: true, shift: true }))).toBe("Ctrl+Shift+W");
    expect(comboFromEvent(keydown({ key: "w", code: "KeyW", ctrl: true }))).toBe("Ctrl+W");
  });
});
