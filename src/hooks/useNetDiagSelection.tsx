import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { fleetTargetKey } from "../lib/types";
import type { HostId, Workspace } from "../lib/types";
import { buildTargetTree, type TargetRow } from "../lib/targetTree";
import { useSharedTargets, type FleetTargetInfo } from "./useFleetTargets";

/** Quelle question est posée. Les deux servent dans le même incident : « je ne
 * joins plus db-1 », puis « et depuis web-1, tu le joins ? » — et le second
 * sens n'ouvre aucune connexion SSH, donc il répond encore sur un hôte qui est
 * lui-même la panne. */
export type DiagDirection = "from" | "to";

export interface NetDiagSelection {
  direction: DiagDirection;
  /** Change le sens **et** vide la sélection : les deux sens ne cochent pas la
   * même liste (voir `selectable`), donc garder les cases reviendrait à
   * conserver des cibles que le nouveau sens ne sait pas viser. */
  setDirection: (direction: DiagDirection) => void;
  filter: string;
  setFilter: (filter: string) => void;
  selected: Set<string>;
  /** Ce qui est cochable, qui n'est pas la même liste dans les deux sens : le
   * sens « vers » sonde l'adresse d'un hôte enregistré, et un conteneur Docker
   * ou la machine locale n'en a pas. */
  selectable: FleetTargetInfo[];
  rows: TargetRow<FleetTargetInfo>[];
  visibleKeys: string[];
  toggle: (key: string) => void;
  toggleKeys: (keys: string[], checked: boolean) => void;
  selectAll: () => void;
  selectNone: () => void;
  /** Repart d'une source unique — l'hôte depuis le menu duquel l'onglet vient
   * d'être visé, ou cette machine. Voir le commentaire de son appel dans
   * `NetDiagTab`. */
  seedSource: (hostId: HostId | null) => void;
}

const NetDiagSelectionContext = createContext<NetDiagSelection | null>(null);

/**
 * La sélection de sources du diagnostic réseau, partagée entre le panneau de
 * barre latérale (l'arborescence, qui la coche) et l'onglet (la grille de
 * résultats, qui la lance).
 *
 * **Pourquoi un contexte plutôt qu'un champ d'`AppContext`** : `modules/types`
 * demande de n'ajouter à ce contexte-là que ce dont un *deuxième* module a
 * besoin, et cet état n'appartient qu'au module `netdiag`. Un fournisseur monté
 * autour du contenu d'`App` atteint les deux points de rendu du registre
 * (`renderModulePanel` et `renderModuleTab`) sans faire grossir l'interface
 * centrale.
 *
 * La liste des cibles elle-même vient de `useSharedTargets` : elle est commune
 * à ce module et à celui de la flotte, et n'est interrogée qu'une fois pour
 * toute l'app (voir `TargetsProvider`).
 */
export function NetDiagSelectionProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  const { allTargets } = useSharedTargets();

  const [direction, setDirectionState] = useState<DiagDirection>("from");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    // Quelque chose est toujours coché à l'arrivée : une sélection vide ferait
    // refuser le bouton avant que l'utilisateur ait rien fait de mal.
    () => new Set(["local"]),
  );

  const selectable = useMemo(
    () => (direction === "from" ? allTargets : allTargets.filter((t) => t.target.kind === "ssh")),
    [direction, allTargets],
  );

  // Rangées dans l'arborescence de dossiers, comme la barre latérale et
  // l'onglet de flotte — le filtre y couvre aussi les tags de l'hôte porteur
  // (voir `lib/targetTree.ts`).
  const { rows, visibleKeys } = useMemo(
    () => buildTargetTree({
      targets: selectable,
      hosts: workspace.hosts,
      groups: workspace.groups,
      query: filter,
    }),
    [selectable, workspace.hosts, workspace.groups, filter],
  );

  const setDirection = useCallback((next: DiagDirection) => {
    setDirectionState(next);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Cocher/décocher tout un dossier (ou tout un hôte relais) d'un coup. */
  const toggleKeys = useCallback((keys: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(visibleKeys)), [visibleKeys]);
  const selectNone = useCallback(() => setSelected(new Set()), []);

  const seedSource = useCallback((hostId: HostId | null) => {
    setSelected(new Set([hostId ? fleetTargetKey({ kind: "ssh", hostId }) : "local"]));
  }, []);

  const value = useMemo<NetDiagSelection>(
    () => ({
      direction, setDirection, filter, setFilter, selected, selectable,
      rows, visibleKeys, toggle, toggleKeys, selectAll, selectNone, seedSource,
    }),
    [direction, setDirection, filter, selected, selectable, rows, visibleKeys, toggle, toggleKeys, selectAll, selectNone, seedSource],
  );

  return <NetDiagSelectionContext.Provider value={value}>{children}</NetDiagSelectionContext.Provider>;
}

/** Lance une erreur hors du fournisseur plutôt que de rendre un état vide : un
 * panneau qui n'afficherait aucune cible sans rien dire est exactement la
 * panne silencieuse que le registre de modules cherche à rendre impossible. */
export function useNetDiagSelection(): NetDiagSelection {
  const value = useContext(NetDiagSelectionContext);
  if (!value) throw new Error("useNetDiagSelection utilisé hors de NetDiagSelectionProvider");
  return value;
}
