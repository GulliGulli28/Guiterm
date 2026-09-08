import { parentPath } from "./panePath";
import type { PaneSource, Workspace } from "./types";

/** Une chose de l'app qu'un module peut vouloir passer à un autre.
 *
 * **Le point du bus d'objets.** Jusqu'ici, relier deux verticales coûtait un
 * champ d'`AppContext` (`openTerminalIn` en est le seul exemple abouti), et le
 * contrat de ce contexte interdit — à raison — de le laisser grossir. Résultat
 * mesuré au 2026-09-08 : dix-sept modules, deux liens. Ici un module *déclare*
 * ce qu'il sait faire d'un objet (`ObjectContribution`), et gagne ses liens
 * entrants sans qu'aucun autre fichier ne bouge.
 *
 * **Une variante n'arrive qu'avec son destinataire.** C'est la leçon MongoDB
 * appliquée au bus : un `kind` que personne n'accepte donnerait un menu
 * « Envoyer vers… » vide, tout en compilant. `objects.test.ts` le fait
 * échouer, donc `endpoint`, `targets` et `text` arriveront avec les tranches
 * qui les acceptent, pas avant.
 *
 * Aucune des formes n'est inventée : `PaneSource` et le chemin courant sont
 * exactement ce que manipule `TransferTab`.
 */
export type AppObject =
  /** Un fichier ou un dossier sur une machine — locale, SSH, conteneur Docker
   * ou pod K8s, indifféremment : c'est ce que `PaneSource` recouvre déjà. */
  | { kind: "remotePath"; source: PaneSource; path: string; isDir: boolean };

/** Comment nommer l'objet dans l'en-tête du menu qui offre ses actions.
 *
 * Prend le workspace parce qu'un objet ne porte que des identifiants : c'est
 * lui qui sait qu'un `hostId` s'appelle « prod-web-1 ». Un identifiant devenu
 * introuvable (hôte supprimé pendant que le menu était ouvert) se dit, plutôt
 * que de rendre une chaîne vide qui laisserait croire à un objet sans nom.
 */
export function describeObject(obj: AppObject, workspace: Workspace): string {
  switch (obj.kind) {
    case "remotePath": {
      const where = describeSource(obj.source, workspace);
      return where ? `${obj.path} — ${where}` : obj.path;
    }
  }
}

/** D'où vient un chemin, en une poignée de mots. Vide pour la machine locale :
 * « /etc/nginx — cette machine » n'apprend rien qu'un chemin local ne dise
 * déjà. */
export function describeSource(source: PaneSource, workspace: Workspace): string {
  switch (source.kind) {
    case "local":
      return "";
    case "remote":
      return hostLabel(source.hostId, workspace);
    case "docker":
      return `${hostLabel(source.hostId, workspace)} : ${source.containerId}`;
    case "k8s":
      return `${hostLabel(source.hostId, workspace)} : ${source.podName}`;
  }
}

function hostLabel(hostId: string, workspace: Workspace): string {
  return workspace.hosts.find((h) => h.id === hostId)?.label ?? "hôte supprimé";
}

/** Le dossier qui contient `path`, ou `path` lui-même s'il en est déjà un.
 *
 * Ce dont ont besoin les destinataires d'un `remotePath` : « ouvrir un
 * terminal ici » et « ouvrir un transfert ici » se positionnent tous deux sur
 * un dossier, qu'on ait désigné un fichier ou son répertoire.
 *
 * Délègue à `parentPath`, qui gère les deux familles de séparateurs. Ce n'est
 * pas de la précaution : le panneau **gauche** d'un transfert est local, donc
 * sous Windows un `remotePath` vaut `C:\Users\quelquun\fichier.txt` — et
 * découper sur `/` y renverrait la racine du disque, exactement le bug que
 * `panePath.ts` raconte en tête. */
export function directoryOf(obj: AppObject & { kind: "remotePath" }): string {
  return obj.isDir ? obj.path : parentPath(obj.path);
}
