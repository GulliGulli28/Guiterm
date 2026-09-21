import type { HostKind, KeyId } from "./types";

export type AuthKind = "agent" | "password" | "privateKey" | "keyboardInteractive";

/** Le formulaire a-t-il pu lire le coffre ? `loaded` : les champs montrent la
 * valeur enregistrée. `unavailable` : coffre verrouillé, champs vides sans
 * que ça veuille dire quoi que ce soit. */
export type StoredSecretsState = "loading" | "loaded" | "unavailable";

/** Le champ secret que la méthode d'authentification utilise — ou aucun :
 * l'agent n'en a pas, et une clé du trousseau porte sa passphrase elle-même
 * (`save_host` ne l'enregistrerait pas sous l'hôte). RDP est toujours à mot
 * de passe, quel que soit `authKind`, que son sélecteur ne propose pas. */
export function secretSlot(kind: HostKind, authKind: AuthKind, keyId: KeyId | null): "password" | "passphrase" | null {
  if (kind !== "ssh" && kind !== "rdp") return null;
  if (kind === "rdp") return "password";
  switch (authKind) {
    case "password":
    case "keyboardInteractive":
      return "password";
    case "privateKey":
      return keyId ? null : "passphrase";
    case "agent":
      return null;
  }
}

/** Ce que `save_host` reçoit dans `secret` : `null` = ne pas toucher, `""` =
 * effacer, sinon remplacer. Un champ vide n'efface que si le formulaire a pu
 * montrer la valeur enregistrée — sinon l'utilisateur n'a rien décidé. */
export function secretToSave(field: string | null, stored: StoredSecretsState): string | null {
  if (field === null) return null;
  if (field !== "") return field;
  return stored === "loaded" ? "" : null;
}
