import type { ReactNode } from "react";
import type { NotificationKind } from "../lib/notifications";
import type { AppPreferences } from "../lib/preferences";
import type { TabMeta, Workspace } from "../lib/types";

/** Ce qu'un module reçoit de l'app pour rendre ses contributions.
 *
 * Volontairement **pas** un miroir des ~18 callbacks qu'`App.tsx` passe à
 * `HostsPanel` : une contribution n'est pas un composant à signature uniforme
 * (ce serait une fiction, cf. `docs/architecture-extensions.md` §6), c'est une
 * fonction de rendu qui se referme sur ce dont elle a besoin. Ce contexte ne
 * porte donc que ce qui est réellement transversal.
 *
 * **N'ajouter un champ ici que quand un deuxième module en a besoin.** Un
 * contexte qui grossit à chaque migration redevient la liste centrale que ce
 * découpage doit supprimer.
 */
export interface AppContext {
  workspace: Workspace;
  preferences: AppPreferences;
  /** Bannière d'état + notification d'erreur. Prend un message déjà formulé
   * pour l'utilisateur, pas une exception. */
  reportError: (message: string) => void;
  pushNotification: (kind: NotificationKind, message: string) => void;
  /** Remplace le workspace en mémoire par celui que le backend vient de
   * renvoyer — les commandes Tauri rendent le workspace entier après écriture,
   * d'où l'argument plutôt qu'un rechargement. */
  refreshWorkspace: (next: Workspace) => void;
}

/** Le rendu d'un onglet d'un `kind` donné.
 *
 * `App.tsx` garde la coquille (montage/masquage, `key`, `Suspense`) : c'est le
 * shell d'onglets, qui reste noyau. La contribution ne rend que le contenu.
 *
 * `render(...)` est écrit en **méthode abrégée**, pas en propriété-fonction :
 * TypeScript rend les paramètres d'une méthode bivariants, ce qui permet de
 * ranger un `ModuleDef<"fleet">` dans une liste de `ModuleDef` sans aucun
 * `as`. Écrit `render: (tab: …) => …`, la contravariance des propriétés
 * imposerait un cast à chaque module — un cast par module est précisément ce
 * qui finit par cacher une vraie erreur.
 */
export interface TabContribution<K extends TabMeta["kind"]> {
  kind: K;
  render(tab: Extract<TabMeta, { kind: K }>, ctx: AppContext, isActive: boolean): ReactNode;
}

export interface ModuleDef<K extends TabMeta["kind"] = TabMeta["kind"]> {
  id: string;
  /** Nom lisible — pas encore affiché nulle part, mais c'est ce qui nommera le
   * module le jour où le registre devient visible par l'utilisateur. */
  label: string;
  tab: TabContribution<K>;
}

/** Aide au typage : lie le `kind` au type de `tab` reçu par `render`, ce
 * qu'une annotation `ModuleDef` posée à la main ne ferait pas. */
export function defineModule<K extends TabMeta["kind"]>(def: ModuleDef<K>): ModuleDef<K> {
  return def;
}
