import type { DockerContainer, FleetTarget, Host, HostId } from "./types";

/** Le nom affichable d'une cible, au mieux de ce qu'on sait d'elle.
 *
 * « Au mieux » n'est pas une précaution de style : un conteneur Docker d'un run
 * passé peut avoir disparu du listing en direct, et un hôte peut avoir été
 * supprimé du workspace depuis. Dans les deux cas la vue retombe sur
 * l'identifiant plutôt que sur une case vide — un rapport qui n'attribue plus
 * ses résultats à personne ne vaut rien.
 *
 * Vit dans `lib/` parce que deux modules l'utilisent : la flotte (résultats et
 * historique) et les runbooks (résultats par étape et rapports). C'était une
 * fonction locale de `FleetTab` jusqu'à ce que le second en ait besoin. */
export function targetLabel(
  t: FleetTarget,
  hostById: Map<HostId, Host>,
  dockerContainers: Map<HostId, DockerContainer[]>,
): string {
  if (t.kind === "local") return "Terminal local";
  if (t.kind === "ssh") return hostById.get(t.hostId)?.label ?? t.hostId;
  const host = hostById.get(t.hostId);
  if (t.kind === "k8s") {
    const name = t.containerName ? `${t.podName} › ${t.containerName}` : t.podName;
    return host ? `${name} (${host.label})` : name;
  }
  const container = dockerContainers.get(t.hostId)?.find((c) => c.id === t.containerId);
  const name = container?.name ?? t.containerId.slice(0, 12);
  return host ? `${name} (${host.label})` : name;
}
