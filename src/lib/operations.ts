/** Static reference for the adaptive engine's small text DSL — see
 * `core::adaptive`'s module docs for the authoritative grammar. Used to
 * render a syntax cheat-sheet in the UI (Snippets panel, Fleet Tab); the
 * actual parsing/evaluation always happens server-side. */
export const DSL_FUNCTIONS: { name: string; args: string; label: string }[] = [
  { name: "install-package", args: "<nom>", label: "Installer un paquet" },
  { name: "remove-package", args: "<nom>", label: "Supprimer un paquet" },
  { name: "update-packages", args: "", label: "Mettre à jour le système" },
  { name: "start-service", args: "<nom>", label: "Démarrer un service" },
  { name: "stop-service", args: "<nom>", label: "Arrêter un service" },
  { name: "restart-service", args: "<nom>", label: "Redémarrer un service" },
  { name: "enable-service", args: "<nom>", label: "Activer un service au démarrage" },
  { name: "disable-service", args: "<nom>", label: "Désactiver un service au démarrage" },
  { name: "service-logs", args: "<nom>", label: "Afficher les logs récents d'un service" },
  { name: "create-directory", args: "<chemin>", label: "Créer un dossier" },
  { name: "remove-directory", args: "<chemin>", label: "Supprimer un dossier" },
  { name: "create-user", args: "<nom>", label: "Créer un utilisateur" },
  { name: "remove-user", args: "<nom>", label: "Supprimer un utilisateur" },
  { name: "reboot", args: "", label: "Redémarrer l'hôte" },
  { name: "set-hostname", args: "<nom>", label: "Changer le nom d'hôte" },
  { name: "open-port", args: "<port>", label: "Ouvrir un port dans le pare-feu" },
  { name: "close-port", args: "<port>", label: "Fermer un port dans le pare-feu" },
];

export const DSL_CONDITION_FIELDS: { field: string; example: string }[] = [
  { field: "os", example: "target os: debian" },
  { field: "name", example: "target name: web-  (nom de l'hôte/conteneur/shell, sous-chaîne)" },
  { field: "tag", example: "target tag: production  (correspondance exacte)" },
  { field: "ram", example: "target ram: > 80" },
  { field: "cpu", example: "target cpu: >= 4" },
  { field: "load", example: "target load: > 1.5" },
  { field: "uptime", example: "target uptime: > 30  (jours)" },
];
