/** Le type d'une clé publique OpenSSH (`ssh-ed25519 AAAA…`), tel qu'on le
 * lit à l'écran : « ed25519 », « RSA », « ECDSA ». */
export function keyTypeOf(publicKey: string): string {
  const algo = publicKey.trim().split(/\s+/)[0] ?? "";
  if (algo === "ssh-ed25519") return "ed25519";
  if (algo === "ssh-rsa" || algo.startsWith("rsa-sha2")) return "RSA";
  if (algo.startsWith("ecdsa-")) return "ECDSA";
  if (algo.startsWith("sk-")) return "Clé matérielle";
  return algo.replace(/^ssh-/, "") || "?";
}

/** L'empreinte SHA-256 d'une clé publique, au format d'OpenSSH
 * (`SHA256:` puis le base64 sans bourrage du hachage du blob) — celle que
 * `ssh-keygen -lf` affiche et qu'un administrateur communique. `null` si la
 * ligne ne contient pas de blob lisible. */
export async function openSshFingerprint(publicKey: string): Promise<string | null> {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const b64 = btoa(String.fromCharCode(...digest)).replace(/=+$/, "");
  return `SHA256:${b64}`;
}
