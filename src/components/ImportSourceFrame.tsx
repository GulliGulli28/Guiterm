import type { ReactNode } from "react";
import type { ImportSource } from "../lib/importSources";

/**
 * Le corps d'une source dans la fenêtre « Importer des hôtes ».
 *
 * Chaque source (AWS, Azure, Ansible…) gardait sa propre modale : voile, titre,
 * bouton Fermer. Elles vivent maintenant dans une seule fenêtre, qui porte le
 * titre et la fermeture ; il ne reste ici qu'une ligne d'introduction et la
 * colonne que la source remplit.
 *
 * `overlayExtra` : un panneau qui se superpose (la connexion Azure). Il garde
 * son positionnement `fixed` ; il est rendu ici pour rester dans l'arbre de la
 * source qui l'ouvre.
 */
export function ImportSourceFrame({ source, intro, overlayExtra, children }: {
  source: ImportSource;
  intro?: ReactNode;
  overlayExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-import-body={source} className="flex min-h-0 flex-1 flex-col">
      {intro && (
        <p className="shrink-0 border-b border-[var(--c-border)] px-4 py-2 text-[11.5px] text-[var(--c-text-muted)]">{intro}</p>
      )}
      {children}
      {overlayExtra}
    </div>
  );
}
