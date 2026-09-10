/** Reconnaît, dans un message d'erreur, un refus de droits — le seul cas où
 * proposer « passer ce panneau en root » a un sens.
 *
 * Pourquoi une liste de tournures plutôt qu'un code d'erreur : il n'y en a
 * pas. Un panneau de transfert parle à quatre backends qui rapportent leurs
 * refus de quatre façons, et deux d'entre eux relaient le texte d'un
 * programme distant, dans la langue du serveur :
 *
 * - SFTP : `russh-sftp` rend son `SSH_FX_PERMISSION_DENIED` en clair
 *   (« Permission denied: Permission denied ») ;
 * - shell distant (`du`, `find`, `tar`, Docker exec, K8s exec) : la sortie
 *   d'erreur de `sh`, donc `Permission denied` / `Permission non accordée`
 *   selon la locale du serveur ;
 * - système de fichiers local : le message d'`std::io::Error` de la plateforme
 *   (`Accès refusé` sous Windows en français) ;
 * - shell élevé : nos propres messages, qui enveloppent l'un des précédents.
 *
 * Volontairement conservateur : proposer l'élévation à tort ajoute un bouton
 * inutile, mais ne pas la proposer quand il faudrait laisse l'utilisateur
 * bloqué sans rien pour s'en sortir — d'où quelques tournures larges. Le
 * `EACCES`/`EPERM` nu est inclus parce que c'est ce que rendent les couches
 * qui ne traduisent rien. */
const REFUSALS = [
  "permission denied",
  "permission non accordée",
  "permission refusée",
  "operation not permitted",
  "opération non permise",
  "accès refusé",
  "acces refuse",
  "access is denied",
  "eacces",
  "eperm",
];

export function isPermissionDenied(message: unknown): boolean {
  if (message === null || message === undefined) return false;
  const text = String(message).toLowerCase();
  return REFUSALS.some((refusal) => text.includes(refusal));
}
