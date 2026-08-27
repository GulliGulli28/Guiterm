import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { fleetTargetKey } from "../lib/types";
import type { DockerContainer, FleetTarget, Host, HostFacts, HostId, K8sPod, Workspace } from "../lib/types";
import { profileInCommand } from "../lib/awsInstances";

/** One selectable target, with what the pickers show next to it. */
export interface FleetTargetInfo {
  key: string;
  target: FleetTarget;
  label: string;
  sub: string;
  facts?: HostFacts | null;
  lastFactsAtMs?: number | null;
  /** The AWS profile this target is reached through, when it is — the
   * per-account cut, which targeting by tag can't express. Read out of the
   * host's proxy command; `null` for everything else. */
  profile?: string | null;
  /** L'hôte enregistré auquel la cible se rattache : elle-même pour un hôte
   * SSH, l'hôte relais pour un conteneur Docker ou un pod K8s. Absent pour le
   * terminal local. Sert à ranger la cible dans l'arborescence de dossiers et
   * à lui prêter les tags de son hôte (`lib/targetTree.ts`) — l'information
   * était déjà dans `target`, mais seulement sous une forme propre à chaque
   * variante. */
  hostId?: HostId | null;
}

/**
 * Every target a run can be aimed at: this machine, every SSH host, and every
 * *live* Docker container and Kubernetes pod.
 *
 * **Extracted from `FleetTab` rather than copied**, when the network
 * diagnostics tab needed the same list. The live listings are the reason: a
 * second copy would mean two places deciding that only running containers can
 * be `exec`'d into, that an unreachable daemon contributes nothing instead of
 * failing the panel, and that a multi-container pod flattens to one entry per
 * container. This repo has already paid for that shape of duplication once,
 * with the SSH tunnel block that existed in three copies.
 */
export function useFleetTargets(workspace: Workspace) {
  const sshHosts = useMemo(() => workspace.hosts.filter((h) => h.kind === "ssh"), [workspace.hosts]);
  const dockerHosts = useMemo(() => workspace.hosts.filter((h) => h.kind === "dockerExec"), [workspace.hosts]);
  const k8sHosts = useMemo(() => workspace.hosts.filter((h) => h.kind === "k8sExec"), [workspace.hosts]);

  const groupName = useCallback(
    (h: Host) => (h.groupId ? workspace.groups.find((g) => g.id === h.groupId)?.name ?? "" : ""),
    [workspace.groups],
  );

  // Docker containers are a live daemon listing, not workspace-persisted
  // state — fetched per `dockerExec` host, best-effort (an unreachable daemon
  // just contributes no containers rather than erroring the panel). Only
  // running containers are offered: a stopped one can't `exec` into.
  const [dockerContainers, setDockerContainers] = useState<Map<HostId, DockerContainer[]>>(new Map());
  const [loadingContainers, setLoadingContainers] = useState(false);
  const dockerHostKey = dockerHosts.map((h) => h.id).join(",");
  const refreshContainers = useCallback(async () => {
    if (dockerHosts.length === 0) return;
    setLoadingContainers(true);
    const next = new Map<HostId, DockerContainer[]>();
    await Promise.all(
      dockerHosts.map(async (h) => {
        try {
          next.set(h.id, (await api.listDockerContainers(h.id)).filter((c) => c.state === "running"));
        } catch {
          next.set(h.id, []);
        }
      }),
    );
    setDockerContainers(next);
    setLoadingContainers(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockerHostKey]);
  useEffect(() => { void refreshContainers(); }, [refreshContainers]);

  // Same idea, one level deeper: a K8s pod may have more than one container,
  // each a distinct exec target — flattened into one entry per container (or
  // per pod, if it only has one) rather than a separate picker step.
  const [k8sPods, setK8sPods] = useState<Map<HostId, K8sPod[]>>(new Map());
  const [loadingPods, setLoadingPods] = useState(false);
  const k8sHostKey = k8sHosts.map((h) => h.id).join(",");
  const refreshPods = useCallback(async () => {
    if (k8sHosts.length === 0) return;
    setLoadingPods(true);
    const next = new Map<HostId, K8sPod[]>();
    await Promise.all(
      k8sHosts.map(async (h) => {
        try {
          next.set(h.id, (await api.listK8sPods(h.id)).filter((p) => p.ready));
        } catch {
          next.set(h.id, []);
        }
      }),
    );
    setK8sPods(next);
    setLoadingPods(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k8sHostKey]);
  useEffect(() => { void refreshPods(); }, [refreshPods]);

  const allTargets = useMemo<FleetTargetInfo[]>(() => {
    const items: FleetTargetInfo[] = [
      { key: "local", target: { kind: "local" }, label: "Terminal local", sub: "" },
    ];
    for (const h of sshHosts) {
      items.push({
        key: fleetTargetKey({ kind: "ssh", hostId: h.id }),
        target: { kind: "ssh", hostId: h.id },
        label: h.label,
        hostId: h.id,
        sub: [groupName(h), h.address].filter(Boolean).join(" · "),
        facts: h.lastFacts,
        lastFactsAtMs: h.lastFactsAtMs,
        profile: profileInCommand(h.proxyCommand),
      });
    }
    for (const h of dockerHosts) {
      for (const c of dockerContainers.get(h.id) ?? []) {
        items.push({
          key: fleetTargetKey({ kind: "docker", hostId: h.id, containerId: c.id }),
          target: { kind: "docker", hostId: h.id, containerId: c.id },
          label: c.name,
          hostId: h.id,
          sub: `${h.label} · ${c.image}`,
          // The host's profile, not the container's: it is how the machine
          // running Docker is reached, same as `compose_adaptive_for_docker`.
          profile: profileInCommand(h.proxyCommand),
        });
      }
    }
    for (const h of k8sHosts) {
      for (const p of k8sPods.get(h.id) ?? []) {
        const containerNames = p.containers.length > 1 ? p.containers : [null];
        for (const containerName of containerNames) {
          items.push({
            key: fleetTargetKey({ kind: "k8s", hostId: h.id, podName: p.name, containerName }),
            target: { kind: "k8s", hostId: h.id, podName: p.name, containerName },
            label: containerName ? `${p.name} › ${containerName}` : p.name,
            hostId: h.id,
            sub: `${h.label} · ${p.namespace}`,
            profile: profileInCommand(h.proxyCommand),
          });
        }
      }
    }
    return items;
  }, [sshHosts, dockerHosts, k8sHosts, dockerContainers, k8sPods, groupName]);

  return {
    allTargets,
    sshHosts,
    dockerHosts,
    k8sHosts,
    /** Exposed because a result row still has to name a container that is only
     * known from the live listing — the target itself carries an id. */
    dockerContainers,
    k8sPods,
    loadingContainers,
    loadingPods,
    refreshContainers,
    refreshPods,
  };
}

export type FleetTargets = ReturnType<typeof useFleetTargets>;

const TargetsContext = createContext<FleetTargets | null>(null);

/**
 * Appelle [`useFleetTargets`] **une seule fois** pour toute l'application.
 *
 * Les listings Docker et Kubernetes sont des interrogations de démon en direct,
 * pas de l'état persisté : deux appels du hook, c'est deux salves de requêtes
 * au lancement, et deux listes qui peuvent diverger dès qu'un conteneur
 * démarre entre les deux. Tant que les deux arborescences de cibles vivaient
 * chacune dans son onglet, c'était invisible — un seul onglet était monté à la
 * fois la plupart du temps. Depuis que la sélection est dans la barre latérale,
 * le panneau et l'onglet sont montés ensemble, et la divergence deviendrait
 * visible : le panneau cocherait un conteneur que l'onglet ne connaît pas.
 */
export function TargetsProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  const targets = useFleetTargets(workspace);
  return <TargetsContext.Provider value={targets}>{children}</TargetsContext.Provider>;
}

/** Lance une erreur hors du fournisseur plutôt que de rendre une liste vide :
 * une arborescence de cibles silencieusement vide est exactement la panne que
 * le registre de modules s'attache à rendre impossible. */
export function useSharedTargets(): FleetTargets {
  const value = useContext(TargetsContext);
  if (!value) throw new Error("useSharedTargets utilisé hors de TargetsProvider");
  return value;
}
