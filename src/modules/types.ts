import type { ReactNode } from "react";
import type { TerminalTabHandle } from "../components/TerminalTab";
import type { NotificationKind } from "../lib/notifications";
import type { AppPreferences } from "../lib/preferences";
import type {
  AwsSessionAlert, AwsSsoSession, Group, GroupId, Host, HostId, KeyAlgorithm, KeyId,
  PortForwardId, PortForwardKind, SnippetId, SqlConnection, TabMeta, VaultStatus, Workspace,
} from "../lib/types";
import type { SidebarPanelKind } from "../lib/sidebarButtons";

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
  /** Écrire une préférence depuis un onglet — pour les réglages qui se
   * changent là où ils s'appliquent plutôt que dans le panneau Réglages (la
   * bascule « fichiers cachés » d'un panneau de transfert). Le lecteur et
   * l'écrivain vont ensemble ; c'est la seule raison d'ajouter un champ ici. */
  updatePreferences: (p: AppPreferences) => void;
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
  render(tab: TabOfKind<K>, ctx: AppContext, isActive: boolean): ReactNode;
}

/** Ce qu'un panneau de barre latérale peut demander à l'app, en plus
 * d'`AppContext`.
 *
 * C'est volontairement une **liste centrale**, et il faut être honnête sur ce
 * que ce commit gagne : la dépendance ne disparaît pas, elle cesse d'être
 * déclarée **trois fois**. Avant, ajouter un panneau demandait d'éditer
 * `SidebarProps` (45 props), le JSX de passe-plat de `Sidebar.tsx`, et le site
 * d'appel dans `App.tsx`. Maintenant : un fichier de module et une ligne de
 * registre, avec l'oubli attrapé par `tsc`.
 *
 * Ces actions sont celles qu'`App.tsx` possède réellement — ouvrir un onglet,
 * ouvrir un formulaire, ouvrir une modale. Les écritures qui ne sont qu'un
 * `api.X(...).then(refreshWorkspace)` y figurent encore : les rapatrier dans
 * leur module supprimerait une bonne moitié de cette interface, mais c'est un
 * changement de responsabilité, pas un déplacement — à faire à part, et à
 * vérifier pour lui-même.
 */
export interface SidebarActions {
  // ── Ouvrir un onglet ──────────────────────────────────────────────────
  connect: (host: Host) => void;
  connectDocker: (host: Host, containerId: string) => void;
  connectK8s: (host: Host, podName: string, containerName: string | null) => void;
  connectRdpView: (host: Host) => void;
  openTransfer: (host: Host, dockerContainerId?: string, k8sPodName?: string, k8sContainerName?: string | null) => void;
  openLocalTerminal: (shell?: string) => void;
  quickSSH: (cmd: string) => void;
  connectSql: (conn: SqlConnection) => void;
  probeReachability: (host: Host) => void;
  searchFiles: (host: Host) => void;

  // ── Ouvrir un formulaire ou une modale ────────────────────────────────
  newHost: () => void;
  editHost: (host: Host) => void;
  newHostInGroup: (groupId: GroupId) => void;
  newGroup: () => void;
  newGroupUnder: (parentId: GroupId) => void;
  editGroup: (group: Group) => void;
  newSqlConnection: () => void;
  editSqlConnection: (conn: SqlConnection) => void;
  importCloud: () => void;
  importAnsible: () => void;
  importAwsDatabases: () => void;
  configureSso: () => void;
  reconnectSso: (session: AwsSsoSession) => void;
  addAwsProfiles: (session: AwsSsoSession) => void;

  // ── Écritures de workspace ────────────────────────────────────────────
  addSnippet: (name: string, command: string) => void;
  updateSnippet: (id: SnippetId, name: string, command: string) => void;
  deleteSnippet: (id: SnippetId) => void;
  runSnippet: (command: string, targetTabIds?: string[]) => void;
  runAdaptiveSnippet: (programText: string, targetTabIds?: string[]) => void;
  saveAdaptiveSnippet: (id: SnippetId | null, name: string, command: string) => void;
  addForward: (input: { hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => void;
  updateForward: (input: { id: PortForwardId; hostId: HostId; kind: PortForwardKind; bindAddress: string; bindPort: number; destAddress: string; destPort: number }) => Promise<unknown>;
  deleteForward: (id: PortForwardId) => void;
  addKey: (name: string, path: string, passphrase: string | null) => void;
  generateKey: (name: string, algorithm: KeyAlgorithm, passphrase: string | null) => void;
  deleteKey: (id: KeyId) => void;
  renameKey: (id: KeyId, name: string) => void;

  // ── État que les panneaux affichent ───────────────────────────────────
  activeHostId: HostId | null;
  openTerminals: { id: string; label: string }[];
  awsRefreshToken: number;
  awsAlerts: AwsSessionAlert[];
  vaultStatus: VaultStatus | null;
  onVaultStatusChange: () => void;
  updatePreferences: (p: AppPreferences) => void;

  // ── Boutons de la bande qui ouvrent un onglet plutôt qu'un panneau ────
  openFleet: () => void;
  openNetDiag: () => void;
}

/** Le rendu d'un panneau de barre latérale. Même contrat que `TabContribution` :
 * `Sidebar.tsx` garde la coquille (bande de boutons, conteneur, `Suspense`),
 * la contribution ne rend que le contenu. */
export interface PanelContribution<P extends SidebarPanelKind> {
  kind: P;
  render(ctx: AppContext, actions: SidebarActions): ReactNode;
}

/** Un module apporte un onglet, un panneau, ou les deux.
 *
 * Trois formes distinctes plutôt qu'un seul type à propriétés optionnelles, et
 * ce n'est pas cosmétique : avec `tab?`/`panel?` et des paramètres de type à
 * valeur par défaut, un module sans panneau voyait `P` retomber sur
 * `SidebarPanelKind` **entier**. Les preuves d'exhaustivité du registre
 * excluaient alors l'union complète et ne pouvaient plus rien signaler — deux
 * garde-fous verts en permanence. Trouvé en cassant le registre exprès : les
 * tests d'exécution échouaient, `tsc` non.
 *
 * Ici, une contribution absente est absente du type, donc invisible pour les
 * `infer` du registre.
 */
export interface TabModule<K extends TabMeta["kind"]> {
  id: string;
  /** Nom lisible — pas encore affiché nulle part, mais c'est ce qui nommera le
   * module le jour où le registre devient visible par l'utilisateur. */
  label: string;
  /** Les domaines de commandes Tauri (`src-tauri/src/commands/<domaine>.rs`)
   * que ce module possède.
   *
   * Granularité du **domaine**, pas de la commande : `main.rs` a un fichier
   * par domaine, donc ajouter une commande à un domaine existant n'a aucune
   * raison de demander une écriture ici, alors qu'ajouter un domaine est
   * exactement la décision qu'on veut forcer. `tauriCommands.test.ts` vérifie
   * que tout domaine enregistré est possédé par un module ou déclaré noyau.
   *
   * C'est ce qui rendra l'étape 3 mécanique : extraire un module en sidecar,
   * c'est déplacer les domaines listés ici. */
  commandDomains?: readonly string[];
  tab: TabContribution<K>;
}

export interface PanelModule<P extends SidebarPanelKind> {
  id: string;
  label: string;
  /** Les domaines de commandes Tauri (`src-tauri/src/commands/<domaine>.rs`)
   * que ce module possède.
   *
   * Granularité du **domaine**, pas de la commande : `main.rs` a un fichier
   * par domaine, donc ajouter une commande à un domaine existant n'a aucune
   * raison de demander une écriture ici, alors qu'ajouter un domaine est
   * exactement la décision qu'on veut forcer. `tauriCommands.test.ts` vérifie
   * que tout domaine enregistré est possédé par un module ou déclaré noyau.
   *
   * C'est ce qui rendra l'étape 3 mécanique : extraire un module en sidecar,
   * c'est déplacer les domaines listés ici. */
  commandDomains?: readonly string[];
  panel: PanelContribution<P>;
}

export interface TabAndPanelModule<K extends TabMeta["kind"], P extends SidebarPanelKind> {
  id: string;
  label: string;
  /** Les domaines de commandes Tauri (`src-tauri/src/commands/<domaine>.rs`)
   * que ce module possède.
   *
   * Granularité du **domaine**, pas de la commande : `main.rs` a un fichier
   * par domaine, donc ajouter une commande à un domaine existant n'a aucune
   * raison de demander une écriture ici, alors qu'ajouter un domaine est
   * exactement la décision qu'on veut forcer. `tauriCommands.test.ts` vérifie
   * que tout domaine enregistré est possédé par un module ou déclaré noyau.
   *
   * C'est ce qui rendra l'étape 3 mécanique : extraire un module en sidecar,
   * c'est déplacer les domaines listés ici. */
  commandDomains?: readonly string[];
  tab: TabContribution<K>;
  panel: PanelContribution<P>;
}

/** Aide au typage : lie chaque `kind` au type reçu par son `render`, ce qu'une
 * annotation posée à la main ne ferait pas. L'ordre des surcharges compte — la
 * forme complète d'abord, sinon un module à deux contributions se ferait
 * capturer par la première qui correspond partiellement. */
export function defineModule<K extends TabMeta["kind"], P extends SidebarPanelKind>(
  def: TabAndPanelModule<K, P>,
): TabAndPanelModule<K, P>;
export function defineModule<K extends TabMeta["kind"]>(def: TabModule<K>): TabModule<K>;
export function defineModule<P extends SidebarPanelKind>(def: PanelModule<P>): PanelModule<P>;
export function defineModule(def: unknown): unknown {
  return def;
}
