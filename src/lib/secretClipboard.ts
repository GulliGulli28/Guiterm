import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Combien de temps un secret copié reste dans le presse-papiers. */
export const SECRET_CLIPBOARD_TTL_MS = 30_000;

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Copie un secret et l'efface du presse-papiers au bout de trente secondes —
 * **seulement s'il y est encore** : si l'utilisateur a copié autre chose
 * entre-temps, ce n'est plus à nous d'y toucher (Bitwarden fait pareil).
 * Une seconde copie avant l'échéance remplace la première minuterie.
 *
 * `io` est injectable pour les tests ; par défaut le presse-papiers système
 * via le plugin Tauri.
 */
export async function copySecret(
  value: string,
  io: { write: (t: string) => Promise<void>; read: () => Promise<string>; clear: () => Promise<void> } = {
    write: writeText,
    read: readText,
    clear: () => writeText(""),
  },
  ttlMs = SECRET_CLIPBOARD_TTL_MS,
): Promise<void> {
  await io.write(value);
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    io.read()
      .then((current) => (current === value ? io.clear() : undefined))
      .catch(() => {});
  }, ttlMs);
}
