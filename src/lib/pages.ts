import type { TabMeta } from "./types";

/**
 * Les pages : ce qu'on **gère**, ouvert en onglet unique sur toute la largeur.
 *
 * La refonte (`docs/refonte-ui.md`, « Panneau pour ce qu'on parcourt, page
 * pour ce qu'on gère ») sort les Réglages, GuiVault, les Clés et empreintes,
 * le Cloud et l'Activité de la barre latérale, où ils s'empilaient dans
 * 300 px pendant que la zone principale restait vide. Une page est un onglet
 * comme un autre — elle se ferme, se réordonne et se restaure — mais il n'y
 * en a jamais deux du même genre, et la barre latérale replie son panneau
 * tant qu'une page est au premier plan.
 */
export type PageKind = "settings" | "activity";

export const PAGE_KINDS: readonly PageKind[] = ["settings", "activity"];

/** Le titre de l'onglet et de la page. */
export const PAGE_LABELS: Record<PageKind, string> = {
  settings: "Réglages",
  activity: "Activité",
};

export function isPageKind(kind: string): kind is PageKind {
  return (PAGE_KINDS as readonly string[]).includes(kind);
}

export type PageTab = Extract<TabMeta, { kind: PageKind }>;

export function isPageTab(tab: TabMeta | null | undefined): tab is PageTab {
  return !!tab && isPageKind(tab.kind);
}
