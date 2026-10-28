/** Une saisie « user@hôte[:port] » (avec ou sans `ssh ` devant), comprise
 * comme une connexion directe — la connexion rapide du panneau Hôtes et de
 * l'accueil. `null` si ce n'en est pas une : la saisie est alors une
 * recherche parmi les hôtes. */
export function parseSSHInput(raw: string): { username: string; address: string; port: number } | null {
  const str = raw.trim().replace(/^ssh\s+/, "");
  const m = str.match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[3] ? parseInt(m[3], 10) : 22;
  if (!port || port < 1 || port > 65535) return null;
  return { username: m[1], address: m[2], port };
}

/** La commande que la connexion rapide tape dans un terminal local. */
export function quickSshCommand({ username, address, port }: { username: string; address: string; port: number }): string {
  return port === 22 ? `ssh ${username}@${address}` : `ssh -p ${port} ${username}@${address}`;
}
