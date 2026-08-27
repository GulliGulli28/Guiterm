interface ConnectionFailedProps {
  /** Phrase complète, pas un simple libellé de cible : « démarrer le terminal
   * local » et « se connecter à tel hôte » ne se disent pas pareil. */
  title: string;
  /** Optionnel : un échec sans message reste un échec à réessayer, et la ligne
   * disparaît plutôt que d'afficher un « null » à l'utilisateur. */
  error?: string | null;
  onRetry: () => void;
  /** Absent quand l'onglet n'a pas de quoi se fermer lui-même (les onglets de
   * base de données, les panneaux de transfert) — le bouton n'est alors pas
   * affiché plutôt que d'être sans effet. */
  onClose?: () => void;
  /** Recouvre son parent positionné, pour les onglets qui gardent leur vue
   * montée mais masquée derrière (les terminaux, l'aperçu RDP) plutôt que de
   * la remplacer. */
  overlay?: boolean;
}

/**
 * Écran d'échec de connexion, commun à tous les onglets de session : SSH,
 * Docker/K8s exec, terminal local, aperçu RDP, SQL, Redis, MongoDB et les
 * panneaux de transfert.
 *
 * Sa raison d'être n'est pas l'uniformité visuelle mais le bouton
 * « Réessayer ». La cause d'un échec est très souvent transitoire — serveur
 * qui redémarre, VPN qui remonte, code à usage unique saisi trop tard — et
 * jusqu'ici chaque onglet mort obligeait à le fermer puis à rouvrir la cible
 * depuis la barre latérale, en perdant sa place dans la barre d'onglets.
 *
 * Côté appelant, `onRetry` incrémente un compteur d'essais qui est la seule
 * dépendance de l'effet de connexion en dehors de la cible elle-même :
 * l'incrémenter rejoue tout le cycle, nettoyage de la session précédente
 * compris, sans dupliquer la logique de connexion ni risquer de laisser une
 * session ouverte derrière soi.
 */
export function ConnectionFailed({ title, error, onRetry, onClose, overlay }: ConnectionFailedProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 p-6 text-center ${
        overlay ? "absolute inset-0" : "min-h-0 flex-1"
      }`}
    >
      <p className="text-sm text-[var(--c-text-secondary)]">{title}</p>
      {error && <p className="max-w-md break-words text-xs text-rose-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={onRetry}
          className="rounded-md bg-[var(--c-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
        >
          Réessayer
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-md bg-[var(--c-bg2)] px-3 py-1.5 text-xs font-medium text-[var(--c-text)] hover:bg-white/5"
          >
            Fermer l'onglet
          </button>
        )}
      </div>
    </div>
  );
}
