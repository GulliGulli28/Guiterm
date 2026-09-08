import { parentPath } from "./panePath";
import type { HostId, PaneSource, Workspace } from "./types";

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
  | { kind: "remotePath"; source: PaneSource; path: string; isDir: boolean }
  /** Une machine joignable, telle qu'elle apparaît dans une sortie de
   * commande. `port` est nul quand le texte n'en portait pas — `10.0.3.12`
   * tout seul reste une cible de ping ou de DNS, ce que le module de
   * diagnostic sait faire ; c'est un tunnel qui exigerait un port.
   *
   * `via` est l'hôte **depuis lequel l'adresse a été vue**, `null` pour un
   * terminal local. Ce n'est pas de la décoration : une adresse privée lue
   * dans un `ss` sur un bastion ne veut rien dire depuis cette machine-ci, et
   * la question utile est « depuis ce bastion, est-ce que tu joins ça ? ».
   * C'est exactement le second sens que `useNetDiagSelection` documente. */
  | { kind: "endpoint"; address: string; port: number | null; via: HostId | null }
  /** Un lot de machines déjà choisies, désigné par les clés de
   * `fleetTargetKey` — hôtes SSH, conteneurs Docker, pods K8s et machine
   * locale mêlés, comme la flotte les mélange déjà.
   *
   * Les **clés** et non les cibles elles-mêmes : c'est ce que les deux
   * magasins de sélection (`useFleetSelection`, `useNetDiagSelection`)
   * manipulent, et ce qui survit au fait qu'un conteneur listé il y a dix
   * minutes n'existe peut-être plus. Le destinataire recoupe avec ce qu'il
   * sait viser. */
  | { kind: "targets"; keys: string[] };

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
    case "endpoint":
      return obj.port === null ? obj.address : `${obj.address}:${obj.port}`;
    case "targets":
      return obj.keys.length === 1 ? "1 cible" : `${obj.keys.length} cibles`;
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

/** Une adresse joignable lue dans un morceau de texte quelconque, ou `null`.
 *
 * **Ce que ça n'est pas** : un validateur. Le texte vient d'une sélection dans
 * une sortie de commande, donc il est déjà bordé par ce que l'utilisateur a
 * surligné — le travail est de reconnaître, pas de refuser. Mais reconnaître
 * trop large est pire que rien : proposer « ouvrir un tunnel vers `error` »
 * sur un mot quelconque discréditerait le menu entier. D'où le refus par
 * défaut, et une forme reconnue seulement si elle en a vraiment l'air.
 *
 * Les quatre formes acceptées, dans l'ordre où elles apparaissent en vrai :
 *
 * - `10.0.3.12` / `db.interne.lan` — une adresse nue, sans port ;
 * - `10.0.3.12:5432` / `db.interne.lan:5432` — la forme des sorties de `ss`,
 *   `netstat`, des journaux et des chaînes de connexion ;
 * - `[2001:db8::1]:5432` — l'IPv6 avec port, dont les crochets sont
 *   obligatoires puisque `:` sépare déjà ses groupes ;
 * - `deploy@bastion.example.com` — la forme SSH, dont seule la partie hôte
 *   est retenue : c'est la machine qui est joignable, pas le compte.
 *
 * Une IPv6 **sans** crochets ni port est acceptée aussi (`2001:db8::1`), mais
 * elle ne peut pas porter de port : `2001:db8::1:5432` est une adresse valide
 * à part entière, et deviner qu'on voulait dire autre chose ferait viser une
 * machine qui n'est pas celle affichée.
 */
export interface ParsedEndpoint {
  address: string;
  port: number | null;
}

export function parseEndpoint(text: string): ParsedEndpoint | null {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > 260) return null;

  // `user@hôte` : on ne garde que l'hôte. Fait avant tout le reste, pour que
  // `deploy@10.0.3.12:22` marche comme la même chose sans le compte.
  const at = raw.lastIndexOf("@");
  const candidate = at >= 0 ? raw.slice(at + 1) : raw;
  if (candidate.length === 0) return null;

  // `[…]:port` — la seule façon non ambiguë d'écrire une IPv6 avec un port.
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(candidate);
  if (bracketed) {
    const port = bracketed[2] === undefined ? null : portOrNull(bracketed[2]);
    return bracketed[2] !== undefined && port === null ? null : { address: bracketed[1], port };
  }

  // Deux `:` ou plus sans crochets : c'est une IPv6 nue, jamais un `hôte:port`.
  if (candidate.indexOf(":") !== candidate.lastIndexOf(":")) {
    return isIpv6(candidate) ? { address: candidate, port: null } : null;
  }

  const colon = candidate.indexOf(":");
  const host = colon < 0 ? candidate : candidate.slice(0, colon);
  const port = colon < 0 ? null : portOrNull(candidate.slice(colon + 1));
  if (colon >= 0 && port === null) return null;
  return isHostLike(host) ? { address: host, port } : null;
}

function portOrNull(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function isIpv6(text: string): boolean {
  // Volontairement approximatif : les caractères d'une IPv6 et au moins deux
  // `:`. Écrire la grammaire complète (compression `::`, IPv4 en queue,
  // zone `%eth0`) pour décider s'il faut *proposer* une action serait un coût
  // sans contrepartie — la sonde dira mieux que nous si l'adresse existe.
  return /^[0-9A-Fa-f:]+$/.test(text) && text.includes("::") ? true : /^([0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$/.test(text);
}

/** Une IPv4, ou un nom d'hôte plausible.
 *
 * Le point est **exigé** dans un nom : sans lui, n'importe quel mot d'une
 * sortie de commande (`failed`, `root`, `nginx`) deviendrait une cible
 * proposée. `localhost` est la seule exception, parce qu'elle est fréquente et
 * sans ambiguïté. */
function isHostLike(text: string): boolean {
  if (text.length === 0 || text.length > 253) return false;
  if (text === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split(".").every((part) => Number(part) <= 255);
  }
  return /^(?=.*\.)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(text);
}
