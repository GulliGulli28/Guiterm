import type { RunningSession } from "./types";
import { formatRelativeTime } from "./format";

/**
 * Comment une session persistante se présente dans le gestionnaire.
 *
 * Une fonction pure dans `lib/` plutôt qu'un bout de JSX : ce qu'elle décide
 * est de la formulation, pas de l'affichage — le pluriel, la différence entre
 * une session que personne ne regarde et une session ouverte ailleurs, et le
 * cas où tmux n'a pas rendu de date. Trois choses qu'on peut se tromper en
 * silence et qu'aucun rendu ne signalerait.
 */
export function describeSession(session: RunningSession): { name: string; meta: string } {
  const windows = `${session.windows} fenêtre${session.windows > 1 ? "s" : ""}`;
  // « attachée » ne veut pas dire « occupée » : c'est un client tmux connecté,
  // donc un onglet ouvert quelque part — ici, ou sur une autre machine. La
  // distinction compte parce que c'est elle qui dit ce qu'on peut terminer
  // sans couper le travail de quelqu'un.
  const clients = session.attached > 0
    ? `ouverte ailleurs (${session.attached} client${session.attached > 1 ? "s" : ""})`
    : "détachée — personne ne la regarde";
  return {
    // `createdAtMs === null` veut dire « tmux ne l'a pas dit », pas « 1970 ».
    // Afficher une date d'époque ferait passer une session de ce matin pour
    // une relique.
    name: session.createdAtMs === null
      ? "Session en cours"
      : `Session ouverte ${formatRelativeTime(session.createdAtMs)}`,
    meta: `${windows} · ${clients}`,
  };
}
