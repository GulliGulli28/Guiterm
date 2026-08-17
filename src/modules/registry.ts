import type { ReactNode } from "react";
import type { TabMeta } from "../lib/types";
import type { AppContext } from "./types";
import { activityModule } from "./activity";
import { fleetModule } from "./fleet";
import { netdiagModule } from "./netdiag";
import { rdpModule } from "./rdp";
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
] as const;

/** Les `kind` d'onglet qu'`App.tsx` rend encore lui-même.
 *
 * Cette liste est là pour **rétrécir**. Quand elle sera vide, le registre
 * pourra devenir un `Record<TabMeta["kind"], …>` complet et elle disparaîtra.
 *
 * Les trois onglets liés à un hôte l'ont quittée au commit 2 du chantier —
 * c'était le morceau risqué (`terminalRefs`, split pane, broadcast). Restent
 * le terminal local et SQL. */
export const TABS_STILL_IN_APP = ["local-terminal", "sql"] as const;

/** Erreur de compilation si un `kind` n'est **ni** revendiqué par un module
 * **ni** listé comme restant dans `App.tsx`.
 *
 * C'est ce qui remplace, pendant la migration, l'exhaustivité que le dispatch
 * en cascade donnait gratuitement : un registre consulté à l'exécution est
 * invisible pour `tsc`, donc un nouveau `kind` d'onglet aurait pu n'être rendu
 * nulle part sans que rien ne proteste. Ici, il ne compile pas tant que
 * personne n'a décidé de quel côté il tombe. */
type UncoveredKind = Exclude<
  TabMeta["kind"],
  typeof MODULES[number]["tab"]["kind"] | typeof TABS_STILL_IN_APP[number]
>;
type AssertNever<T extends never> = T;
export type _AllTabKindsCovered = AssertNever<UncoveredKind>;

/** Les onglets encore rendus par `App.tsx`. */
export type TabStillInApp = Extract<TabMeta, { kind: typeof TABS_STILL_IN_APP[number] }>;

/** Sain grâce à `_AllTabKindsCovered` : tout ce qu'aucun module ne revendique
 * est forcément dans cette liste, donc la cascade d'`App.tsx` peut se narrower
 * dessus et retrouver son `assertNever` final. */
export function isTabStillInApp(tab: TabMeta): tab is TabStillInApp {
  return (TABS_STILL_IN_APP as readonly string[]).includes(tab.kind);
}

type AnyTabRenderer = (tab: TabMeta, ctx: AppContext, isActive: boolean) => ReactNode;

// Le seul `as` du registre, et il est localisé ici : chaque module déclare un
// `kind` et une fonction de rendu qui vont ensemble (`defineModule` le lie),
// mais une Map ne peut pas porter cette corrélation. `renderModuleTab` ne
// cherche jamais que par `tab.kind`, donc le rendu retrouvé est toujours celui
// qui a déclaré ce `kind`.
const TAB_RENDERERS = new Map<TabMeta["kind"], AnyTabRenderer>(
  MODULES.map((m) => [m.tab.kind, m.tab.render as AnyTabRenderer]),
);

/** Le rendu du contenu de cet onglet, si un module le revendique.
 *
 * `undefined` — et non `null` — quand aucun ne le fait : `null` est un rendu
 * React légitime (un onglet SQL dont la connexion a disparu en rend un), donc
 * les confondre ferait afficher du vide au lieu de passer la main à
 * `App.tsx`. */
export function renderModuleTab(tab: TabMeta, ctx: AppContext, isActive: boolean): ReactNode | undefined {
  const render = TAB_RENDERERS.get(tab.kind);
  return render ? render(tab, ctx, isActive) : undefined;
}
