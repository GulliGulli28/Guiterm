import { assertNever } from "./exhaustive";
import type { CloudCliError, CloudFailure } from "./types";

/**
 * Les sources de la fenêtre « Importer des hôtes » (`ImportHostsDialog`).
 *
 * Une seule liste, dans l'ordre de la colonne de gauche : c'est elle qui fait
 * que l'accueil, le menu « Ajouter… » du panneau Hôtes et Known Hosts ouvrent
 * la même fenêtre sur la bonne source, au lieu de six modales différentes.
 */
export type ImportSource = "sshConfig" | "aws" | "gcp" | "azure" | "ansible" | "file";

export const IMPORT_SOURCES: { id: ImportSource; label: string }[] = [
  { id: "sshConfig", label: "~/.ssh/config" },
  { id: "aws", label: "AWS" },
  { id: "gcp", label: "Google Cloud" },
  { id: "azure", label: "Azure" },
  { id: "ansible", label: "Inventaire Ansible" },
  { id: "file", label: "Fichier d'export Guiterm" },
];

/** La ligne d'état sous le nom d'une source. `ok` : prête à lister ; `warn` :
 * quelque chose est à régler avant ; `muted` : rien à dire d'avance. */
export interface SourceStatus {
  tone: "ok" | "warn" | "muted";
  text: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Ce que la lecture de `~/.ssh/config` a trouvé, `null` pendant la lecture. */
export function sshConfigStatus(found: number | null, alreadyThere: number): SourceStatus {
  if (found === null) return { tone: "muted", text: "Lecture…" };
  if (found === 0) return { tone: "muted", text: "Aucun hôte trouvé" };
  const fresh = found - alreadyThere;
  if (fresh === 0) return { tone: "muted", text: `${plural(found, "hôte", "hôtes")}, tous déjà présents` };
  return { tone: "ok", text: `${plural(fresh, "hôte à importer", "hôtes à importer")}` };
}

/** Les profils de `~/.aws/config`. */
export function awsStatus(profiles: number | null): SourceStatus {
  if (profiles === null) return { tone: "muted", text: "Lecture des profils…" };
  if (profiles === 0) return { tone: "warn", text: "Aucun profil configuré" };
  return { tone: "ok", text: plural(profiles, "profil", "profils") };
}

/** Ce qu'a donné le sondage d'une CLI cloud : le nombre de projets ou
 * d'abonnements, la raison typée de son refus, ou `null` pendant le sondage. */
export type CloudProbe = { scopes: number } | { reason: CloudCliError | null } | null;

/** Lance le sondage d'une CLI cloud (lister ses projets) et range le
 * résultat ; rend de quoi l'oublier si le composant disparaît avant. Partagé
 * par la fenêtre d'import et la page Cloud. */
export function probeCli(list: () => Promise<unknown[]>, set: (p: CloudProbe) => void): () => void {
  let cancelled = false;
  list()
    .then((found) => { if (!cancelled) set({ scopes: found.length }); })
    .catch((e) => {
      if (cancelled) return;
      const failure = e as Partial<CloudFailure> | null;
      set({ reason: failure && typeof failure === "object" && failure.reason ? failure.reason : null });
    });
  return () => { cancelled = true; };
}

/** Le sondage d'une CLI cloud (`gcloud`, `az`) : la liste de ses projets ou
 * abonnements, ou la raison typée de son refus.
 *
 * Le `switch` se ferme sur `assertNever` : une raison ajoutée à
 * {@link CloudCliError} sans libellé ici est une erreur `tsc`. */
export function cloudCliStatus(
  program: string,
  probe: { scopes: number } | { reason: CloudCliError | null } | null,
  scopeWord: [string, string],
): SourceStatus {
  if (probe === null) return { tone: "muted", text: `Recherche de ${program}…` };
  if ("scopes" in probe) {
    if (probe.scopes === 0) return { tone: "warn", text: `${program} connecté, aucun ${scopeWord[0]}` };
    return { tone: "ok", text: `${program} connecté · ${plural(probe.scopes, ...scopeWord)}` };
  }
  const reason = probe.reason;
  if (!reason) return { tone: "warn", text: `${program} n'a pas répondu` };
  switch (reason.kind) {
    case "cliMissing": return { tone: "warn", text: `CLI ${program} introuvable` };
    case "notLoggedIn": return { tone: "warn", text: "Connexion requise" };
    case "refused": return { tone: "warn", text: "Accès refusé" };
    case "unreadable": return { tone: "warn", text: `${program} n'a pas répondu` };
    default: return assertNever(reason, "cloudCliStatus");
  }
}
