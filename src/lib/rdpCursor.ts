/** Le curseur d'une session RDP, traduit en valeur CSS `cursor`.
 *
 * Le serveur envoie une *forme*, pas une position : la position, c'est celle
 * de la vraie souris de l'utilisateur, et c'est le navigateur qui la connaît.
 * D'où le choix de peindre le curseur en CSS sur le `<canvas>` plutôt que de
 * le compositer dans l'image — composité, il traînerait d'un aller-retour
 * réseau complet derrière la main qui tient la souris.
 *
 * Corollaire assumé : `PointerPosition` (le serveur qui *déplace* le curseur)
 * reste ignoré, une page web ne pouvant pas déplacer le pointeur de l'OS.
 */

export interface RdpPointerBitmap {
  width: number;
  height: number;
  /** Le « point » du curseur : la pointe de la flèche, le centre d'une croix. */
  hotspotX: number;
  hotspotY: number;
  /** RGBA8 non prémultiplié, en base64 — voir `rdp_ipc::SidecarMessage::PointerBitmap`. */
  pixelsBase64: string;
}

export interface RdpPointerUpdate {
  bitmap: RdpPointerBitmap | null;
  hidden: boolean;
}

/** Au-delà, les navigateurs ignorent purement et simplement la déclaration
 * `cursor` — l'utilisateur se retrouverait alors **sans aucun curseur**, ce
 * qui est pire que le curseur système. Un curseur RDP fait presque toujours
 * 32×32, mais rien dans le protocole ne l'impose. */
export const MAX_CURSOR_SIZE = 128;

// `<ArrayBuffer>` explicite, pas le `Uint8ClampedArray` nu : depuis TS 5.7 ce
// dernier vaut `Uint8ClampedArray<ArrayBufferLike>`, que le constructeur
// d'`ImageData` refuse (il exige un vrai `ArrayBuffer`, pas un
// `SharedArrayBuffer`).
export function decodePointerPixels(base64: string): Uint8ClampedArray<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** La valeur `cursor` à poser sur le canvas.
 *
 * `toDataUrl` est injecté parce qu'il a besoin d'un `<canvas>` : la décision
 * (masqué / défaut / image, et quoi faire d'une image inutilisable) est ici,
 * testable sans DOM ; le dessin est dans le composant.
 */
export function pointerCss(
  update: RdpPointerUpdate,
  toDataUrl: (bitmap: RdpPointerBitmap) => string | null,
): string {
  if (update.hidden) return "none";
  const { bitmap } = update;
  if (!bitmap) return "default";

  // Une image vide ou démesurée : retomber sur le curseur système plutôt que
  // d'émettre une déclaration que le navigateur jettera en silence.
  if (bitmap.width <= 0 || bitmap.height <= 0) return "default";
  if (bitmap.width > MAX_CURSOR_SIZE || bitmap.height > MAX_CURSOR_SIZE) return "default";

  const url = toDataUrl(bitmap);
  if (!url) return "default";

  // Un hotspot hors de l'image rend TOUTE la déclaration invalide (donc, là
  // encore, aucun curseur). Serrer plutôt que faire confiance au serveur.
  const hotspotX = clamp(bitmap.hotspotX, 0, bitmap.width - 1);
  const hotspotY = clamp(bitmap.hotspotY, 0, bitmap.height - 1);

  // `default` en repli après la virgule : si l'URL échoue à charger côté
  // navigateur, il reste une flèche plutôt que rien.
  return `url("${url}") ${hotspotX} ${hotspotY}, default`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
