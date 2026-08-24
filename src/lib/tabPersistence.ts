import type { TabMeta } from "./types";

export const STORAGE_KEY = "gui-termius-tabs";

export interface PersistedTab {
  kind: TabMeta["kind"];
  label: string;
  hostId?: string;
  dockerContainerId?: string;
  k8sPodName?: string;
  k8sContainerName?: string | null;
  shell?: string | null;
  /** La session persistante de cet onglet terminal (`termius_core::persistent_shell`).
   * C'est **la** raison d'être de ce champ ici : la session vit côté serveur,
   * donc la retrouver après un redémarrage de l'app suppose que son nom, lui,
   * ait été écrit quelque part. */
  sessionKey?: string;
}

/** Persists only enough to redraw placeholder tabs — never a live session id.
 *
 * `sessionKey` n'en est pas une : c'est un *nom* de session côté serveur,
 * stable d'un lancement à l'autre, valable seulement pour quelqu'un qui a
 * déjà un accès SSH à l'hôte. Un identifiant de session, lui, ne désigne rien
 * après la fermeture du processus. */
export function saveTabs(tabs: TabMeta[]): void {
  const trimmed: PersistedTab[] = tabs.map((t) => {
    const isRemote = t.kind === "terminal" || t.kind === "transfer";
    return {
      kind: t.kind,
      label: t.label,
      hostId: isRemote ? t.hostId : undefined,
      dockerContainerId: isRemote ? t.dockerContainerId : undefined,
      k8sPodName: isRemote ? t.k8sPodName : undefined,
      k8sContainerName: isRemote ? t.k8sContainerName : undefined,
      shell: t.kind === "local-terminal" ? t.shell : undefined,
      sessionKey: t.kind === "terminal" ? t.sessionKey : undefined,
    };
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

export function loadTabs(): PersistedTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Un onglet restauré doit-il se rouvrir tout seul, ou attendre un clic ?
 *
 * Sorti du hook parce que c'est une décision, pas de l'affichage : elle change
 * ce que l'app fait au lancement — jusqu'ici, rien. Trois conditions doivent
 * tenir ensemble, et se tromper sur l'une d'elles ne se voit pas au montage
 * d'un composant.
 *
 * - **Un terminal seulement.** Un panneau de transfert ou un aperçu RDP n'a pas
 *   de session à reprendre ; la clé n'existe que sur les onglets terminal, mais
 *   les trois partagent un membre de `TabMeta`, donc le typage ne l'interdit
 *   pas.
 * - **Une clé.** Sans elle il n'y a rien à rattacher : rouvrir donnerait un
 *   shell vierge, c'est-à-dire exactement ce que la vignette évite de faire
 *   sans qu'on l'ait demandé.
 * - **La préférence.** Désactivée par défaut : l'app ne se connecte à rien au
 *   lancement, et ce contrat ne change que si on le demande.
 */
export function restoredTabStatus(
  tab: PersistedTab,
  resumePersistentTabs: boolean,
): "connected" | "placeholder" {
  const resumable = tab.kind === "terminal" && !!tab.sessionKey;
  return resumable && resumePersistentTabs ? "connected" : "placeholder";
}
