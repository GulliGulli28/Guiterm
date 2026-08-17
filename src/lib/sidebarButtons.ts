import type { SidebarPanelKind } from "../components/Sidebar";

/** Boutons de la barre verticale de gauche que l'utilisateur peut masquer.
 *
 * Les huit premiers changent de panneau (ce sont des `SidebarPanelKind`),
 * `fleet` et `netdiag` ouvrent un onglet — mais du point de vue du réglage
 * c'est la même chose : un bouton visible ou non. « Paramètres » n'en fait pas
 * partie, c'est le chemin de retour vers ce réglage lui-même.
 *
 * Masquer ne désactive **rien** : les onglets déjà ouverts restent, la palette
 * de commandes garde tout, et le backend ne change pas. C'est du rangement
 * visuel — d'où le fait qu'aucun garde-fou de sûreté ne soit nécessaire ici,
 * contrairement à ce que ferait une vraie désactivation de module
 * (cf. `docs/architecture-extensions.md`, étape 3).
 */
export type SidebarButtonId = Exclude<SidebarPanelKind, "settings"> | "fleet" | "netdiag";

export interface SidebarButtonDef {
  id: SidebarButtonId;
  /** Libellé court — celui de l'infobulle, et celui coché dans les réglages :
   * la liste doit se lire contre la barre qu'on a sous les yeux. */
  label: string;
  /** Complément d'infobulle, pour les boutons dont le libellé seul ne dit pas
   * ce qu'ils ouvrent. */
  hint?: string;
}

/** Ordre d'affichage dans la barre — et dans la liste des réglages, pour la
 * même raison. */
export const SIDEBAR_BUTTONS: readonly SidebarButtonDef[] = [
  { id: "knownHosts", label: "Known Hosts" },
  { id: "hosts",      label: "Hôtes" },
  { id: "sftp",       label: "SFTP" },
  { id: "snippets",   label: "Snippets" },
  { id: "tunnels",    label: "Tunnels" },
  { id: "database",   label: "Bases de données" },
  { id: "keychain",   label: "Clés" },
  { id: "aws",        label: "Identités AWS" },
  { id: "fleet",      label: "Opérations de flotte", hint: "exécuter une commande sur plusieurs hôtes à la fois" },
  { id: "netdiag",    label: "Diagnostic réseau", hint: "ping, traceroute, DNS, TCP, HTTP depuis ou vers vos hôtes" },
];

/** `hosts` est le point d'entrée : sans lui, plus rien ne permet d'ouvrir une
 * connexion. C'est le seul bouton dont l'absence coincerait l'utilisateur —
 * tout le reste est masquable. */
export const ALWAYS_VISIBLE_SIDEBAR_BUTTONS: readonly SidebarButtonId[] = ["hosts"];

export function isSidebarButtonVisible(
  id: SidebarButtonId,
  hidden: readonly SidebarButtonId[],
): boolean {
  return ALWAYS_VISIBLE_SIDEBAR_BUTTONS.includes(id) || !hidden.includes(id);
}

/** Le panneau réellement affichable, sachant ce qui est masqué.
 *
 * Appelé au rendu plutôt que dans un effet au moment où le réglage change :
 * ainsi un panneau masqué dans une session précédente — ou masqué pendant
 * qu'il était ouvert — retombe sur « Hôtes » sans qu'un état incohérent puisse
 * survivre à un rechargement. */
export function resolveVisiblePanel(
  panel: SidebarPanelKind,
  hidden: readonly SidebarButtonId[],
): SidebarPanelKind {
  if (panel === "settings") return panel;
  return isSidebarButtonVisible(panel, hidden) ? panel : "hosts";
}
