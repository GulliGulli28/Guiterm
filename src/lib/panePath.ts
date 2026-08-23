/** Manipulation des chemins d'un panneau de transfert.
 *
 * Un panneau affiche indifféremment un système de fichiers POSIX (SFTP,
 * Docker exec, K8s exec) et le système de fichiers local — qui, sous Windows,
 * répond `C:\Users\quelquun`. Traiter les deux comme du POSIX est exactement
 * le bug qui envoyait « dossier parent » à la racine du disque : `C:\Users\x`
 * ne contient aucun `/`, donc la remontée ne trouvait aucun séparateur et
 * repartait sur `/`.
 *
 * Fonctions pures et testées (`panePath.test.ts`) plutôt qu'en ligne dans le
 * composant : c'est la logique qui s'est trompée, pas le rendu. */

/** Séparateur du chemin lui-même, pas de la plateforme : un panneau distant
 * ouvert depuis Windows reste en POSIX. Un chemin est « Windows » s'il commence
 * par une lettre de lecteur (`C:\`, `C:/`, `C:`) ou par un UNC (`\\serveur`). */
export function pathSeparator(path: string): "\\" | "/" {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\") ? "\\" : "/";
}

/** Racine dont on ne remonte plus : `/` en POSIX, `C:\` (ou `\\serveur\`) sous
 * Windows. */
function rootOf(path: string): string {
  if (pathSeparator(path) === "/") return "/";
  const drive = /^([a-zA-Z]:)/.exec(path);
  if (drive) return `${drive[1]}\\`;
  const unc = /^(\\\\[^\\/]+(?:[\\/][^\\/]+)?)/.exec(path);
  return unc ? `${unc[1]}\\` : "\\";
}

/** Dossier parent de `path`. Rend `path` inchangé quand il n'y a plus de
 * parent (on est à la racine) : mieux vaut un bouton sans effet qu'un saut
 * silencieux ailleurs. */
export function parentPath(path: string): string {
  const root = rootOf(path);
  // Une fin de chemin en séparateur n'est pas un niveau de plus.
  const trimmed = path.length > root.length ? path.replace(/[\\/]+$/, "") : path;
  if (trimmed.length <= root.length) return root;
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return trimmed;
  // `/var` → `` et `C:\Users` → `C:` : plus court que la racine veut dire
  // qu'on vient de l'atteindre.
  const head = trimmed.slice(0, index);
  return head.length < root.length ? root : head;
}

/** Ajoute un segment à un chemin, avec le séparateur de ce chemin. */
export function joinPath(base: string, segment: string): string {
  const sep = pathSeparator(base);
  return /[\\/]$/.test(base) ? `${base}${segment}` : `${base}${sep}${segment}`;
}

/** Dossier contenant `path` — pour ouvrir un résultat de recherche là où il
 * se trouve. Identique à [`parentPath`] : un résultat est un chemin complet,
 * pas un dossier courant. */
export const containingDir = parentPath;

/** Dernier segment d'un chemin (le nom du fichier ou du dossier). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export interface Crumb {
  label: string;
  path: string;
}

/** Le chemin courant découpé en niveaux cliquables — ce qui remplace le champ
 * « Aller à » : remonter de trois niveaux d'un coup se fait en un clic au lieu
 * de retaper un chemin absolu. */
export function breadcrumbs(path: string): Crumb[] {
  if (!path) return [];
  const root = rootOf(path);
  const sep = pathSeparator(path);
  const rest = path.slice(root.length);
  const crumbs: Crumb[] = [{ label: root, path: root }];
  let current = root;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    current = /[\\/]$/.test(current) ? `${current}${part}` : `${current}${sep}${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** La commande qui amène un terminal dans `cwd`.
 *
 * Le guillemetage dépend du shell qui va la lire, pas de la plateforme du
 * chemin : un chemin POSIX part dans un `sh` distant, un chemin Windows dans
 * le shell local. En apostrophes pour POSIX (rien n'y est interprété, donc un
 * chemin contenant `$` ou une espace passe intact) ; en guillemets doubles
 * pour Windows, les seuls que `cmd` et PowerShell comprennent tous les deux.
 *
 * `cd /d` pour `cmd` uniquement : sans lui, `cd D:\travail` depuis `C:` ne
 * change pas de lecteur — il enregistre juste le dossier courant de `D:` et
 * ne bouge pas. PowerShell, lui, ne connaît pas ce commutateur. */
export function cdCommand(cwd: string, shell?: string | null): string {
  if (pathSeparator(cwd) === "/") {
    return `cd '${cwd.replace(/'/g, `'\\''`)}'`;
  }
  const isCmd = /(^|[\\/])cmd(\.exe)?$/i.test((shell ?? "").trim());
  return `cd ${isCmd ? "/d " : ""}"${cwd}"`;
}
