import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { fleetTargetKey } from "../lib/types";
import type { DockerContainer, FleetTarget, Host, HostId, Workspace } from "../lib/types";
import { api } from "../lib/api";
import { buildTargetTree, type TargetRow } from "../lib/targetTree";
import { useSharedTargets, type FleetTargetInfo } from "./useFleetTargets";

/** Un critère de sélection fondé sur l'état collecté. `enabled` décide si
 * `selectByFacts` le regarde : plusieurs critères se combinent (ET) sans qu'un
 * champ numérique ait besoin d'une valeur sentinelle « désactivé ». Réservé aux
 * hôtes SSH : les cibles Docker exec/K8s/locale n'ont pas de `lastFacts`. */
export interface FactFilters {
  ram: { enabled: boolean; value: number }; // RAM utilisée % > valeur
  cpu: { enabled: boolean; value: number }; // nombre de CPU >= valeur
  load1: { enabled: boolean; value: number }; // charge à 1 min > valeur
  uptimeDays: { enabled: boolean; value: number }; // uptime < valeur jours
  os: { enabled: boolean; value: string }; // nom/id d'OS contient valeur
}

export const DEFAULT_FACT_FILTERS: FactFilters = {
  ram: { enabled: false, value: 80 },
  cpu: { enabled: false, value: 2 },
  load1: { enabled: false, value: 1 },
  uptimeDays: { enabled: false, value: 7 },
  os: { enabled: false, value: "" },
};

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

  const hostById = useMemo(() => new Map(workspace.hosts.map((h) => [h.id, h])), [workspace.hosts]);
  const targetsByKey = useMemo(() => new Map(allTargets.map((t) => [t.key, t.target])), [allTargets]);

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FactFilters>(DEFAULT_FACT_FILTERS);
  const [collectingFacts, setCollectingFacts] = useState(false);
  const [mode, setMode] = useState<FleetMode>("command");
  const [hasTargetLine, setHasTargetLine] = useState(false);

  const hasFacts = sshHosts.some((h) => h.lastFacts != null);

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

  const anyFilterEnabled =
    filters.ram.enabled || filters.cpu.enabled || filters.load1.enabled || filters.uptimeDays.enabled || filters.os.enabled;

  /** Sélectionne tout hôte SSH dont le dernier état collecté satisfait *tous*
   * les critères cochés (ET) — un critère décoché est ignoré, pas traité comme
   * « n'importe quoi ». Les cibles Docker exec/locale n'ont pas d'état à
   * filtrer. */
  const selectByFacts = useCallback(() => {
    if (!anyFilterEnabled) {
      onError("Coche au moins un critère avant de sélectionner");
      return;
    }
    const keys = sshHosts
      .filter((h) => {
        const f = h.lastFacts;
        if (!f) return false;
        if (filters.ram.enabled && !(f.memUsedPct != null && f.memUsedPct > filters.ram.value)) return false;
        if (filters.cpu.enabled && !(f.cpus != null && f.cpus >= filters.cpu.value)) return false;
        if (filters.load1.enabled && !(f.load1 != null && f.load1 > filters.load1.value)) return false;
        if (filters.uptimeDays.enabled) {
          const days = f.uptimeSecs != null ? f.uptimeSecs / 86400 : null;
          if (!(days != null && days < filters.uptimeDays.value)) return false;
        }
        if (filters.os.enabled) {
          const q = filters.os.value.trim().toLowerCase();
          if (!q) return false;
          const hay = `${f.osName ?? ""} ${f.osId ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .map((h) => fleetTargetKey({ kind: "ssh", hostId: h.id }));
    setSelected(new Set(keys));
  }, [anyFilterEnabled, onError, sshHosts, filters]);

  // L'état collecté vit sur l'hôte lui-même (`lastFacts`, persisté côté serveur
  // par `collect_facts`) — aucune copie locale à tenir à jour. SSH uniquement,
  // comme l'exécuteur de flotte.
  const collectFacts = useCallback(async (hostIds?: HostId[]) => {
    if (collectingFacts) return;
    const ids = hostIds ?? sshHosts.map((h) => h.id);
    if (ids.length === 0) return;
    setCollectingFacts(true);
    try {
      const { outcomes, workspace: updated } = await api.collectFacts(ids);
      onWorkspaceUpdate(updated);
      const failed = outcomes.filter((o) => o.error != null);
      if (failed.length > 0) {
        const names = failed.map((o) => hostById.get(o.hostId)?.label ?? o.hostId).join(", ");
        onError(`${failed.length} hôte(s) n'ont pas répondu à la sonde d'état : ${names}`);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setCollectingFacts(false);
    }
  }, [collectingFacts, sshHosts, onWorkspaceUpdate, onError, hostById]);

  const value = useMemo<FleetSelection>(() => ({
    allTargets, sshHosts, dockerHosts, k8sHosts, targetsByKey, dockerContainers, rows, visibleKeys, profiles,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
    filter, setFilter, selected, setSelected, toggle, toggleKeys, selectAll, selectNone, selectByProfile,
    filters, setFilters, hasFacts, anyFilterEnabled, selectByFacts, collectingFacts, collectFacts,
    mode, setMode, hasTargetLine, setHasTargetLine,
  }), [
    allTargets, sshHosts, dockerHosts, k8sHosts, targetsByKey, dockerContainers, rows, visibleKeys, profiles,
    loadingContainers, loadingPods, refreshContainers, refreshPods,
    filter, selected, toggle, toggleKeys, selectAll, selectNone, selectByProfile,
    filters, hasFacts, anyFilterEnabled, selectByFacts, collectingFacts, collectFacts,
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
