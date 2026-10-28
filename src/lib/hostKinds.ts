import type { ComponentType } from "react";
import type { HostKind } from "./types";
import { IconTerminal, IconDocker, IconKubernetes, IconMonitor } from "../components/ui-icons";

interface HostKindMeta {
  key: HostKind;
  label: string;
  /** Pour un choix serré (le sélecteur de type du formulaire d'hôte). */
  short: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

export const HOST_KINDS: HostKindMeta[] = [
  { key: "ssh", label: "SSH", short: "SSH", Icon: IconTerminal },
  { key: "dockerExec", label: "Docker exec", short: "Docker", Icon: IconDocker },
  { key: "k8sExec", label: "Kubernetes exec", short: "Kubernetes", Icon: IconKubernetes },
  { key: "rdp", label: "RDP", short: "RDP", Icon: IconMonitor },
];

export function hostKindMeta(kind: HostKind | undefined): HostKindMeta {
  return HOST_KINDS.find((k) => k.key === (kind ?? "ssh")) ?? HOST_KINDS[0];
}
