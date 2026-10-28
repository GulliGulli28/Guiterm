import type { AuthMethod, Host, HostId } from "./types";

/** Ce dont la commande a besoin : un hôte enregistré, ou celui qu'un
 * formulaire est en train de décrire. */
export interface SshCommandSpec {
  address: string;
  port: number;
  username: string;
  auth: AuthMethod;
  jumpVia: HostId[];
  proxyCommand?: string | null;
  agentForward?: boolean;
  keepaliveIntervalSecs?: number | null;
}

/** Un argument tel qu'un shell POSIX le relira à l'identique. `~` reste nu
 * en tête : entre guillemets, il ne serait plus développé. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function endpoint(h: { username: string; address: string }): string {
  return `${h.username ? `${h.username}@` : ""}${h.address}`;
}

/**
 * La commande `ssh` d'OpenSSH qui ferait la même connexion : port, clé,
 * certificat, bastions, commande de proxy, transfert d'agent, keepalive.
 *
 * Ce qui ne se dit pas en ligne de commande n'y est pas : un mot de passe,
 * une clé du trousseau sans fichier, les variables et snippets de démarrage.
 * La commande de proxy passe telle quelle — `%h`, `%p`, `%r` sont aussi les
 * jetons d'OpenSSH.
 */
export function sshCommandLine(host: SshCommandSpec, hosts: Host[]): string {
  const args: string[] = ["ssh"];
  if (host.port !== 22) args.push("-p", String(host.port));
  if (typeof host.auth === "object" && "privateKey" in host.auth) {
    const { path, certPath } = host.auth.privateKey;
    if (path.trim()) args.push("-i", shellQuote(path.trim()));
    if (certPath?.trim()) args.push("-o", shellQuote(`CertificateFile=${certPath.trim()}`));
  }
  const jumps = host.jumpVia
    .map((id) => hosts.find((h) => h.id === id))
    .filter((h): h is Host => !!h)
    .map((h) => `${endpoint(h)}${h.port !== 22 ? `:${h.port}` : ""}`);
  if (jumps.length) args.push("-J", shellQuote(jumps.join(",")));
  if (host.proxyCommand?.trim()) args.push("-o", shellQuote(`ProxyCommand=${host.proxyCommand.trim()}`));
  if (host.agentForward) args.push("-A");
  if (host.keepaliveIntervalSecs && host.keepaliveIntervalSecs > 0) args.push("-o", `ServerAliveInterval=${host.keepaliveIntervalSecs}`);
  args.push(shellQuote(endpoint(host)));
  return args.join(" ");
}
