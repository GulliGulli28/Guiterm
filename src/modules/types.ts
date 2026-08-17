import type { ReactNode } from "react";
import type { TerminalTabHandle } from "../components/TerminalTab";
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
  /** Ferme l'onglet. `"disconnected"` distingue une session qui est tombée
   * d'une fermeture demandée par l'utilisateur — la notification n'est pas la
   * même. */
  closeTab: (id: string, reason?: "disconnected") => void;
  /** Signale la fin d'une commande assez longue pour qu'on soit parti voir
   * ailleurs. */
  notifyLongCommand: (command: string, durationMs: number, where: string) => void;
  /** Recopie la frappe de cet onglet vers les autres cibles de diffusion. */
  mirrorInput: (sourceTabId: string, data: string) => void;
  /** Publie (ou retire, avec `null`) la poignée impérative d'un terminal.
   *
   * C'est ce qui rend les onglets liés à un hôte plus délicats que les autres :
   * la palette, le broadcast, le zoom et la recherche appellent des méthodes
   * *sur* le terminal. Le registre déplace l'endroit où le composant est
   * monté, pas la propriété de cette table — elle reste dans `App.tsx`. */
  registerTerminalHandle: (tabId: string, handle: TerminalTabHandle | null) => void;
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
/** Les membres de `TabMeta` que ce `kind` peut désigner.
 *
 * Pas un simple `Extract<TabMeta, { kind: K }>` : `terminal`, `transfer` et
 * `rdp-view` partagent **un seul** membre de `TabMeta`, dont le champ `kind`
 * vaut déjà l'union des trois. Ce membre n'est donc assignable à
 * `{ kind: "terminal" }` pour aucun des trois, et `Extract` rendait `never` —
 * silencieusement, jusqu'à ce que le premier accès à `tab.hostId` échoue.
 * Ici on garde le membre dès que son `kind` **recouvre** `K`. */
export type TabOfKind<K extends TabMeta["kind"], T = TabMeta> = T extends { kind: infer TK }
  ? [Extract<TK, K>] extends [never] ? never : T
  : never;

export interface TabContribution<K extends TabMeta["kind"]> {
  kind: K;
  render(tab: TabOfKind<K>, ctx: AppContext, isActive: boolean): ReactNode;
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
