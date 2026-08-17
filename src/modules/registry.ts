import type { ReactNode } from "react";
import type { TabMeta } from "../lib/types";
import type { AppContext } from "./types";
import { activityModule } from "./activity";
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
] as const;

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
type KindWithoutModule = Exclude<TabMeta["kind"], typeof MODULES[number]["tab"]["kind"]>;
type AssertNever<T extends never> = T;
export type _EveryTabKindHasAModule = AssertNever<KindWithoutModule>;

type AnyTabRenderer = (tab: TabMeta, ctx: AppContext, isActive: boolean) => ReactNode;

// Le seul `as` du registre, et il est localisé ici : chaque module déclare un
// `kind` et une fonction de rendu qui vont ensemble (`defineModule` le lie),
// mais une Map ne peut pas porter cette corrélation. `renderModuleTab` ne
// cherche jamais que par `tab.kind`, donc le rendu retrouvé est toujours celui
// qui a déclaré ce `kind`.
const TAB_RENDERERS = new Map<TabMeta["kind"], AnyTabRenderer>(
  MODULES.map((m) => [m.tab.kind, m.tab.render as AnyTabRenderer]),
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
