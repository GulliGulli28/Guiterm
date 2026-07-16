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
];

export const DSL_CONDITION_FIELDS: { field: string; example: string }[] = [
  { field: "os", example: "target os: debian" },
  { field: "ram", example: "target ram: > 80" },
  { field: "cpu", example: "target cpu: >= 4" },
  { field: "load", example: "target load: > 1.5" },
  { field: "uptime", example: "target uptime: > 30  (jours)" },
];

export const DSL_EXAMPLE = `target os: debian
sudo: true
install-package nginx

target ram: > 80
restart-service nginx`;
