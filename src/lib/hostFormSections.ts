import type { ConnectStage, HostKind } from "./types";
import { assertNever } from "./exhaustive";

/*
 * Les sections du formulaire d'hôte (`HostForm`) : lesquelles un type d'hôte
 * montre, et laquelle ouvrir quand une connexion d'essai échoue.
 *
 * Hors du composant pour être testées : c'est ici que se décide qu'un hôte
 * RDP n'a rien d'un réseau SSH (bastions, agent, keepalive) — le constat de
 * l'audit était justement un formulaire RDP qui proposait l'agent SSH.
 */

/** Les sections du tiroir, dans l'ordre de la navigation. */
export type HostFormSection = "connexion" | "auth" | "reseau" | "session" | "organisation";

/** Celles qu'un type d'hôte montre. RDP n'a ni réseau SSH ni shell ; Docker
 * et Kubernetes s'authentifient hors de l'app (socket, kubeconfig). */
export function sectionsFor(kind: HostKind): HostFormSection[] {
  switch (kind) {
    case "ssh":
      return ["connexion", "auth", "reseau", "session", "organisation"];
    case "rdp":
      return ["connexion", "auth", "organisation"];
    case "dockerExec":
    case "k8sExec":
      return ["connexion", "session", "organisation"];
    default:
      return assertNever(kind, "type d'hôte");
  }
}

/** La section à ouvrir quand un essai échoue à cette étape. `null` : aucune
 * section n'y peut rien (la clé d'hôte se règle dans Known Hosts). */
export function sectionForStage(stage: ConnectStage): HostFormSection | null {
  switch (stage) {
    case "resolve":
    case "reach":
    case "handshake":
      return "connexion";
    case "proxy":
    case "relay":
      return "reseau";
    case "auth":
      return "auth";
    case "hostKey":
      return null;
    default:
      return assertNever(stage, "étape de connexion");
  }
}

export const STAGE_LABELS: Record<ConnectStage, string> = {
  resolve: "Résolution du nom",
  reach: "Connexion au port",
  proxy: "Commande de proxy",
  handshake: "Poignée de main SSH",
  hostKey: "Clé de l'hôte",
  auth: "Authentification",
  relay: "Passage par le bastion",
};

export const SECTION_LABELS: Record<HostFormSection, string> = {
  connexion: "Connexion",
  auth: "Authentification",
  reseau: "Réseau",
  session: "Session",
  organisation: "Organisation",
};

