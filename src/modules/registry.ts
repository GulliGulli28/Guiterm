import type { ReactNode } from "react";
import type { TabMeta } from "../lib/types";
import type { SidebarPanelKind } from "../lib/sidebarButtons";
import type { AppContext, SidebarActions } from "./types";
import { activityModule } from "./activity";
import { awsModule } from "./aws";
import { hostsModule } from "./hosts";
import { keychainModule } from "./keychain";
import { knownHostsModule } from "./knownHosts";
import { settingsModule } from "./settings";
import { sftpModule } from "./sftp";
import { snippetsModule } from "./snippets";
import { tunnelsModule } from "./tunnels";
import { localTerminalModule } from "./localTerminal";
import { fleetModule } from "./fleet";
import { netdiagModule } from "./netdiag";
import { rdpModule } from "./rdp";
import { sqlModule } from "./sql";
import { terminalModule } from "./terminal";
import { transferModule } from "./transfer";

/** Les modules first-party. Ajouter un module = ajouter un fichier et une
 * ligne ici — au lieu d'éditer le dispatch d'`App.tsx`.
 *
 * **Chaque module porte son propre `lazy(...)`**, là où les imports étaient
 * groupés en tête d'`App.tsx`. Ce sont de gros panneaux rarement tous utilisés
 * (rendu du canvas RDP, ~950 lignes de transfert de fichiers, ~1000 lignes de
 * flotte/DSL adaptatif) : les sortir du chunk initial réduit ce qui doit être
 * parsé avant que l'app soit interactive. Le chargement du chunk lui-même est
 * quasi instantané (empaqueté localement par Tauri, aucun aller-retour
 * réseau) — c'est une question de taille de bundle initial, pas de latence
 * perçue. Seul `terminal` reste eager, c'est le chemin principal.
 *
 * Non annoté volontairement : le type inféré garde le `kind` littéral de
 * chaque module, ce dont la preuve de couverture plus bas a besoin. Une
 * annotation `ModuleDef[]` les écraserait tous en l'union complète. */
export const MODULES = [
  activityModule,
  fleetModule,
  netdiagModule,
  terminalModule,
  transferModule,
  rdpModule,
  localTerminalModule,
  sqlModule,
  hostsModule,
  knownHostsModule,
  sftpModule,
  snippetsModule,
  tunnelsModule,
  keychainModule,
  awsModule,
  settingsModule,
] as const;

/** Les domaines de commandes Tauri qu'aucun module ne possède, et qui n'ont
 * pas vocation à en avoir un.
 *
 * Ce sont les transversaux de la section 3 du document d'architecture : le
 * coffre (tout module qui touche à un secret passe par lui), l'authentification
 * interactive (elle se joue pendant la poignée de main SSH, sous le pool, donc
 * sous les modules), et l'historique de commandes (partagé par le terminal SSH
 * et le terminal local, sans propriétaire naturel).
 *
 * Cette liste est le pendant assumé de l'attribution : y inscrire un domaine
 * est une décision, pas un contournement. Elle ne doit pas servir de dépotoir
 * pour un domaine qu'on n'a pas envie de rattacher. */
export const CORE_COMMAND_DOMAINS: readonly string[] = ["vault", "interactive_auth", "command_history"];

type AssertNever<T extends never> = T;

// `M` nu dans le conditionnel : c'est ce qui le rend distributif sur l'union
// des modules. Un module sans `tab` ne correspond pas et contribue `never`.
type TabKindOf<M> = M extends { tab: { kind: infer K } } ? K : never;
type ClaimedTabKind = TabKindOf<typeof MODULES[number]>;
type KindWithoutModule = Exclude<TabMeta["kind"], ClaimedTabKind>;

/** Erreur de compilation si un `kind` d'onglet n'a pas de module.
 *
 * C'est le garde-fou central du registre, et il remplace l'exhaustivité que
 * la cascade de `if` d'`App.tsx` donnait gratuitement : un registre consulté à
 * l'exécution est invisible pour `tsc`, donc un nouveau `kind` aurait pu
 * n'être rendu nulle part sans que rien ne proteste — la panne MongoDB.
 *
 * Pendant la migration, il tolérait une liste `TABS_STILL_IN_APP` de `kind`
 * encore rendus par `App.tsx` ; elle s'est vidée au commit 3 et a disparu
 * avec. Il n'y a plus de dispatch d'onglet en dehors d'ici. */
export type _EveryTabKindHasAModule = AssertNever<KindWithoutModule>;

/** Même preuve sur l'autre axe : chaque panneau de barre latérale a son
 * module. `Sidebar.tsx` n'a plus de dispatch par `panel`, donc un
 * `SidebarPanelKind` sans module afficherait un panneau vide — la même panne
 * silencieuse que côté onglets. */
type PanelKindOf<M> = M extends { panel: { kind: infer P } } ? P : never;
type ClaimedPanelKind = PanelKindOf<typeof MODULES[number]>;
type PanelWithoutModule = Exclude<SidebarPanelKind, ClaimedPanelKind>;
export type _EveryPanelHasAModule = AssertNever<PanelWithoutModule>;

type AnyTabRenderer = (tab: TabMeta, ctx: AppContext, isActive: boolean) => ReactNode;

// Le seul `as` du registre, et il est localisé ici : chaque module déclare un
// `kind` et une fonction de rendu qui vont ensemble (`defineModule` le lie),
// mais une Map ne peut pas porter cette corrélation. `renderModuleTab` ne
// cherche jamais que par `tab.kind`, donc le rendu retrouvé est toujours celui
// qui a déclaré ce `kind`.
const TAB_RENDERERS = new Map<TabMeta["kind"], AnyTabRenderer>(
  MODULES.flatMap((m) => ("tab" in m ? [[m.tab.kind, m.tab.render as AnyTabRenderer]] : [])),
);

type AnyPanelRenderer = (ctx: AppContext, actions: SidebarActions) => ReactNode;

const PANEL_RENDERERS = new Map<SidebarPanelKind, AnyPanelRenderer>(
  MODULES.flatMap((m) => ("panel" in m ? [[m.panel.kind, m.panel.render as AnyPanelRenderer]] : [])),
);

/** Le rendu du contenu de cet onglet.
 *
 * `undefined` est désormais **impossible** — `_EveryTabKindHasAModule` le
 * prouve à la compilation. Le type le garde quand même : c'est ce que rend une
 * `Map` interrogée avec une clé absente, et le masquer derrière un `!` ferait
 * disparaître la seule trace d'un registre incohérent. `null` reste un rendu
 * légitime (onglet dont l'hôte ou la connexion a été supprimé). */
export function renderModuleTab(tab: TabMeta, ctx: AppContext, isActive: boolean): ReactNode | undefined {
  const render = TAB_RENDERERS.get(tab.kind);
  return render ? render(tab, ctx, isActive) : undefined;
}

/** Le rendu du panneau de barre latérale demandé.
 *
 * Mêmes conventions que `renderModuleTab` : `undefined` est impossible
 * (`_EveryPanelHasAModule`), `null` reste un rendu légitime. */
export function renderModulePanel(
  panel: SidebarPanelKind,
  ctx: AppContext,
  actions: SidebarActions,
): ReactNode | undefined {
  const render = PANEL_RENDERERS.get(panel);
  return render ? render(ctx, actions) : undefined;
}
