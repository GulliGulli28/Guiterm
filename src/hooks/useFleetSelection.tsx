import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DockerContainer, FleetTarget, Host, HostId, Workspace } from "../lib/types";
import { buildTargetTree, type TargetRow } from "../lib/targetTree";
import { useSharedTargets, type FleetTargetInfo } from "./useFleetTargets";
import { useFactSelection } from "./useFactSelection";
import type { FactFilters } from "../lib/facts";

/** Le mode de composition, écrit par l'onglet et lu par le panneau : en
 * « Langage », la sélection est recalculée à chaque frappe depuis le programme
 * et les cases ne sont plus à la main. */
export type FleetMode = "command" | "intent";

export interface FleetSelection {
  allTargets: FleetTargetInfo[];
  sshHosts: Host[];
  dockerHosts: Host[];
  k8sHosts: Host[];
  targetsByKey: Map<string, FleetTarget>;
  /** Le listing Docker en direct — l'onglet en a besoin pour nommer une cible
   * dans ses résultats, y compris ceux d'un run passé. */
  dockerContainers: Map<HostId, DockerContainer[]>;
  rows: TargetRow<FleetTargetInfo>[];
  visibleKeys: string[];
  /** Les profils AWS présents parmi les cibles, pour la rangée de sélection
   * rapide. Vide sur un espace de travail sans hôte importé — ce qui suffit à
   * ne pas afficher la rangée du tout. */
  profiles: string[];

  loadingContainers: boolean;
  loadingPods: boolean;
  refreshContainers: () => Promise<void>;
  refreshPods: () => Promise<void>;

  filter: string;
  setFilter: (filter: string) => void;
  selected: Set<string>;
  /** Écriture brute — l'onglet s'en sert pour la sélection automatique du mode
   * « Langage », qui vient du programme et non des cases. */
  setSelected: (next: Set<string>) => void;
  toggle: (key: string) => void;
  toggleKeys: (keys: string[], checked: boolean) => void;
  selectAll: () => void;
  selectNone: () => void;
  selectByProfile: (profile: string) => void;

  filters: FactFilters;
  setFilters: (update: (prev: FactFilters) => FactFilters) => void;
  hasFacts: boolean;
  anyFilterEnabled: boolean;
  selectByFacts: () => void;
  collectingFacts: boolean;
  collectFacts: (hostIds?: HostId[]) => Promise<void>;

  mode: FleetMode;
  setMode: (mode: FleetMode) => void;
  /** Le programme adaptatif courant porte-t-il au moins une ligne `target` ?
   * Écrit par l'onglet ; le panneau s'en sert pour griser les cases. */
  hasTargetLine: boolean;
  setHasTargetLine: (value: boolean) => void;
}

const FleetSelectionContext = createContext<FleetSelection | null>(null);

interface ProviderProps {
  workspace: Workspace;
  onError: (message: string) => void;
  /** Appelé avec l'espace de travail frais après une collecte d'état, pour que
   * le reste de l'app (pastilles de la liste d'hôtes…) le reprenne aussi. */
  onWorkspaceUpdate: (ws: Workspace) => void;
  children: ReactNode;
}

/**
 * Le choix des cibles d'une opération de flotte, partagé entre le panneau de
 * barre latérale (`FleetTargetsPanel`, qui coche) et l'onglet (`FleetTab`, qui
 * compose et exécute).
 *
 * **Pourquoi un contexte plutôt qu'un champ d'`AppContext`** : `modules/types`
 * demande de n'ajouter à ce contexte-là que ce dont un *deuxième* module a
 * besoin, et tout ceci n'appartient qu'au module `fleet`. Un fournisseur monté
 * autour du contenu d'`App` atteint les deux points de rendu du registre
 * (`renderModulePanel` et `renderModuleTab`) sans faire grossir l'interface
 * centrale.
 *
 * Ce qui a été déplacé ici l'a été d'un bloc : filtre, sélection, pastilles de
 * compte AWS, filtres par état collecté et arborescence formaient déjà un
 * ensemble dans l'ancienne colonne de l'onglet — les couper en deux aurait
 * laissé la sélection pilotable depuis deux endroits qui ne sont plus côte à
 * côte.
 */
export function FleetSelectionProvider({ workspace, onError, onWorkspaceUpdate, children }: ProviderProps) {
  const {
    allTargets, sshHosts, dockerHosts, k8sHosts, dockerContainers,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
  } = useSharedTargets();

  const targetsByKey = useMemo(() => new Map(allTargets.map((t) => [t.key, t.target])), [allTargets]);

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<FleetMode>("command");
  const [hasTargetLine, setHasTargetLine] = useState(false);

  // Critères par état collecté et collecte elle-même : partagés avec le
  // diagnostic réseau, qui pose exactement les mêmes questions.
  const facts = useFactSelection({ sshHosts, onError, onWorkspaceUpdate });

  // Rangées dans l'arborescence de dossiers plutôt qu'à plat — mêmes dossiers
  // et mêmes tags que la barre latérale, et le filtre compare aussi les tags de
  // l'hôte porteur (voir `lib/targetTree.ts`).
  const { rows, visibleKeys } = useMemo(
    () => buildTargetTree({
      targets: allTargets,
      hosts: workspace.hosts,
      groups: workspace.groups,
      query: filter,
    }),
    [allTargets, workspace.hosts, workspace.groups, filter],
  );

  const profiles = useMemo(() => {
    const found = new Set<string>();
    for (const t of allTargets) if (t.profile) found.add(t.profile);
    return [...found].sort();
  }, [allTargets]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Cocher/décocher tout un dossier (ou tout un hôte relais) d'un coup — ce
   * que la liste à plat ne pouvait pas offrir faute de savoir ce qu'était un
   * dossier. Les cibles gérées automatiquement en mode « Langage » ne sont pas
   * touchées : elles y sont recalculées à chaque frappe. */
  const toggleKeys = useCallback((keys: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        const target = targetsByKey.get(key);
        if (mode === "intent" && (hasTargetLine || target?.kind !== "ssh")) continue;
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, [targetsByKey, mode, hasTargetLine]);

  const selectAll = useCallback(() => setSelected(new Set(visibleKeys)), [visibleKeys]);
  const selectNone = useCallback(() => setSelected(new Set()), []);

  /** Sélectionne toutes les cibles jointes via `profile` — la coupe « tous les
   * hôtes du compte X ». S'ajoute à la sélection au lieu de la remplacer, pour
   * que deux comptes se combinent en cliquant les deux. */
  const selectByProfile = useCallback((profile: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of allTargets) if (t.profile === profile) next.add(t.key);
      return next;
    });
  }, [allTargets]);

  const selectByFacts = useCallback(() => {
    const keys = facts.matchingKeys();
    if (keys.length > 0 || facts.anyFilterEnabled) setSelected(new Set(keys));
  }, [facts]);

  const value = useMemo<FleetSelection>(() => ({
    allTargets, sshHosts, dockerHosts, k8sHosts, targetsByKey, dockerContainers, rows, visibleKeys, profiles,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
    filter, setFilter, selected, setSelected, toggle, toggleKeys, selectAll, selectNone, selectByProfile,
    filters: facts.filters, setFilters: facts.setFilters, hasFacts: facts.hasFacts,
    anyFilterEnabled: facts.anyFilterEnabled, selectByFacts,
    collectingFacts: facts.collectingFacts, collectFacts: facts.collectFacts,
    mode, setMode, hasTargetLine, setHasTargetLine,
  }), [
    allTargets, sshHosts, dockerHosts, k8sHosts, targetsByKey, dockerContainers, rows, visibleKeys, profiles,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
    filter, selected, toggle, toggleKeys, selectAll, selectNone, selectByProfile,
    facts, selectByFacts,
    mode, hasTargetLine,
  ]);

  return <FleetSelectionContext.Provider value={value}>{children}</FleetSelectionContext.Provider>;
}

/** Lance une erreur hors du fournisseur plutôt que de rendre un état vide : un
 * panneau qui n'afficherait aucune cible sans rien dire est exactement la panne
 * silencieuse que le registre de modules cherche à rendre impossible. */
export function useFleetSelection(): FleetSelection {
  const value = useContext(FleetSelectionContext);
  if (!value) throw new Error("useFleetSelection utilisé hors de FleetSelectionProvider");
  return value;
}
