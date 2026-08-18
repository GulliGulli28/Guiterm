import type { Host, HostId, PortForward, SqlConnection, Workspace } from "./types";

/** Ce qui, dans le workspace, passe par un hôte SSH donné.
 *
 * Les liens existent depuis toujours dans le modèle — une connexion SQL tunnelée
 * porte l'id de son hôte, un hôte Docker celui de son relais, un tunnel celui de
 * sa machine — mais rien ne les lisait dans ce sens. On pouvait donc supprimer
 * un hôte sans voir qu'une base et deux tunnels en dépendaient, et surtout on ne
 * pouvait pas passer d'un onglet à l'autre : les verticales étaient juxtaposées,
 * jamais reliées.
 *
 * Purement dérivé du `Workspace` déjà en mémoire : aucune commande Tauri, aucun
 * aller-retour. C'est ce qui rend la chose testable sans DOM ni backend.
 */
export interface HostAttachments {
  /** Redirections de ports enregistrées sur cet hôte. */
  forwards: PortForward[];
  /** Bases atteintes *à travers* cet hôte — tunnel SSH, ou fichier SQLite posé
   * sur son disque. « À travers » et non « hébergées par » : le tunnel dit
   * comment on y accède, pas où tourne le serveur. */
  databases: SqlConnection[];
  /** Hôtes Docker/K8s dont cet hôte est le relais SSH. */
  relayedHosts: Host[];
}

/** L'hôte par lequel cette connexion passe, s'il y en a un.
 *
 * Trois formes à couvrir, et c'est la raison d'être de cette fonction : un
 * tunnel SSH (`tunnel.kind === "sshHost"`), un fichier SQLite distant
 * (`sqliteHostId`, qui n'est **pas** un tunnel — c'est une copie par SFTP), et
 * tout le reste qui ne passe par aucun hôte enregistré. Un tunnel SSM en fait
 * partie : sa cible est un identifiant d'instance AWS, pas un hôte d'ici.
 */
export function connectionViaHostId(connection: SqlConnection): HostId | null {
  if (connection.engine === "sqlite") return connection.sqliteHostId ?? null;
  if (connection.engine === "mongodb") return connection.tunnel?.kind === "sshHost" ? connection.tunnel.hostId : null;
  return connection.tunnel?.kind === "sshHost" ? connection.tunnel.hostId : null;
}

export function hostAttachments(workspace: Workspace, hostId: HostId): HostAttachments {
  return {
    forwards: workspace.portForwards.filter((f) => f.hostId === hostId),
    databases: workspace.sqlConnections.filter((c) => connectionViaHostId(c) === hostId),
    relayedHosts: workspace.hosts.filter((h) => h.id !== hostId && h.dockerViaHostId === hostId),
  };
}

/** Rien n'est attaché ? Le panneau n'affiche alors pas de section vide. */
export function hasAttachments(attachments: HostAttachments): boolean {
  return (
    attachments.forwards.length > 0 ||
    attachments.databases.length > 0 ||
    attachments.relayedHosts.length > 0
  );
}

/** Le compte total, pour une pastille ou un libellé — sans avoir à additionner
 * trois longueurs sur chaque site d'appel. */
export function attachmentCount(attachments: HostAttachments): number {
  return attachments.forwards.length + attachments.databases.length + attachments.relayedHosts.length;
}
