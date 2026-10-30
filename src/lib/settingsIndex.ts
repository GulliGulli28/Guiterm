/**
 * Ce que la recherche de la page Réglages connaît : chaque réglage, sa
 * catégorie, et les mots sous lesquels on le cherche.
 *
 * Tenu à la main plutôt que lu dans le DOM : une catégorie n'est rendue qu'à
 * son ouverture, la recherche doit pourtant trouver un réglage d'une autre.
 * `settingsIndex.test.ts` vérifie que chaque `label` figure tel quel dans les
 * sources des Réglages — un libellé renommé sans venir ici fait échouer le
 * test au lieu de rendre un résultat qui ne mène à rien.
 */
export type SettingsCategory = "apparence" | "terminal" | "sftp" | "securite" | "agent" | "raccourcis" | "notifications" | "general";

export interface SettingsEntry {
  category: SettingsCategory;
  /** Le texte du réglage à l'écran : c'est lui que la page fait défiler
   * jusqu'à la vue. */
  label: string;
  /** D'autres mots pour le trouver (synonymes, nom technique). */
  keywords?: string;
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { category: "apparence", label: "Mode d'affichage", keywords: "sombre clair thème dark light" },
  { category: "apparence", label: "Fond de l'interface", keywords: "couleur surface graphite" },
  { category: "apparence", label: "Couleur d'accent", keywords: "indigo couleur" },
  { category: "apparence", label: "Police de l'interface", keywords: "geist typographie" },
  { category: "apparence", label: "Hôtes de la liste", keywords: "taille icône densité" },
  { category: "apparence", label: "Dossiers de la liste d'hôtes", keywords: "taille icône" },
  { category: "apparence", label: "Boutons de la barre latérale", keywords: "masquer rail panneaux" },
  { category: "terminal", label: "Thème", keywords: "couleurs terminal" },
  { category: "terminal", label: "Taille de police", keywords: "texte zoom" },
  { category: "terminal", label: "Copier/coller au clic droit", keywords: "presse-papiers souris" },
  { category: "terminal", label: "Accélération GPU du terminal", keywords: "webgl performances" },
  { category: "terminal", label: "Afficher les performances de rendu", keywords: "fps temps de rendu" },
  { category: "terminal", label: "Suggestions de commandes en local (texte fantôme)", keywords: "complétion historique ghost" },
  { category: "terminal", label: "Suggestions de commandes en SSH (texte fantôme)", keywords: "complétion historique ghost" },
  { category: "terminal", label: "Reconnexion automatique en cas de perte de connexion", keywords: "coupure réseau" },
  { category: "terminal", label: "Prévenir quand une commande longue se termine", keywords: "notification durée" },
  { category: "terminal", label: "Shell local par défaut", keywords: "powershell bash zsh cmd wsl" },
  { category: "sftp", label: "Taille du texte", keywords: "fichiers transfert" },
  { category: "securite", label: "Mot de passe maître", keywords: "coffre chiffré vault secrets" },
  { category: "agent", label: "Clés proposées", keywords: "agent ssh trousseau" },
  { category: "agent", label: "Signer ses commits Git", keywords: "git signature gpg" },
  { category: "raccourcis", label: "Raccourcis", keywords: "clavier touches combinaison" },
  { category: "notifications", label: "Notifier à la perte de connexion", keywords: "alerte" },
  { category: "notifications", label: "Notifier à la fin d'un transfert SFTP", keywords: "alerte fichiers" },
  { category: "notifications", label: "Notifier quand une mise à jour est disponible", keywords: "alerte version" },
  { category: "general", label: "Mises à jour", keywords: "version update" },
  { category: "general", label: "Restaurer les onglets au démarrage", keywords: "session lancement" },
  { category: "general", label: "Reprendre seules les sessions persistantes", keywords: "tmux lancement" },
  { category: "general", label: "Masquer la barre d'état tmux", keywords: "tmux status" },
  { category: "general", label: "Molette et souris dans les sessions tmux", keywords: "tmux défilement" },
  { category: "general", label: "Diagnostic", keywords: "journaux logs" },
  { category: "general", label: "Import / Export", keywords: "configuration sauvegarde fichier" },
];

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Les réglages qui répondent à la recherche, dans l'ordre de l'index. Chaque
 * mot tapé doit se retrouver quelque part (libellé, mots-clés ou nom de la
 * catégorie), sans tenir compte des accents. */
export function searchSettings(query: string, categoryLabels: Record<SettingsCategory, string>): SettingsEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_INDEX.filter((entry) => {
    const haystack = normalize(`${entry.label} ${entry.keywords ?? ""} ${categoryLabels[entry.category]}`);
    return words.every((w) => haystack.includes(w));
  });
}
