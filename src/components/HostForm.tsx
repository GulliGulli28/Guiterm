import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { IconTrash } from "./ui-icons";
import type { AuthMethod, EnvVar, GroupId, Host, HostId, HostKind, KeyId, ProxyProbe, SnippetId, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";
import { HostTreePicker } from "./HostTreePicker";
import { HOST_KINDS } from "../lib/hostKinds";
import { assertNever } from "../lib/exhaustive";

interface HostFormProps {
  workspace: Workspace;
  host: Host | null;
  defaultGroupId?: GroupId | null;
  onCancel: () => void;
  onSave: (input: {
    id: HostId | null;
    label: string;
    kind: HostKind;
    address: string;
    port: number;
    username: string;
    auth: AuthMethod;
    dockerViaHostId: HostId | null;
    jumpVia: HostId[];
    proxyCommand: string | null;
    groupId: GroupId | null;
    tags: string[];
    startupSnippets: SnippetId[];
    envVars: EnvVar[];
    icon: string | null;
    secret: string | null;
    keepaliveIntervalSecs: number | null;
    agentForward: boolean;
  }) => void;
  onDeleteHost?: (id: HostId) => void;
  onWorkspaceUpdate?: (ws: Workspace) => void;
}

/** Verdict of the "Tester" button.
 *
 * Shows the server's own identification string on success rather than a bare
 * tick: "SSH-2.0-OpenSSH_8.0" is proof something real answered, where a green
 * check is just this app's opinion. And the failure case leads with the
 * helper's own words — that is what actually names the problem. */
function ProxyProbeResult({ probe }: { probe: ProxyProbe }) {
  if (probe.kind === "reached") {
    return (
      <div className="rounded-md border border-emerald-800/60 bg-emerald-950/40 px-2.5 py-2">
        <p className="text-xs font-medium text-emerald-300">Le tunnel s'ouvre et un serveur SSH répond.</p>
        <code className="mt-0.5 block truncate font-mono text-[10px] text-emerald-400/80">{probe.banner}</code>
        <p className="mt-1 text-[10px] text-[var(--c-text-muted)]">
          L'authentification n'est pas testée : il reste à vérifier l'utilisateur et la clé.
        </p>
      </div>
    );
  }
  if (probe.kind === "silent") {
    return (
      <div className="rounded-md border border-amber-800/60 bg-amber-950/40 px-2.5 py-2">
        <p className="text-xs font-medium text-amber-300">La commande tourne, mais rien ne répond.</p>
        <p className="mt-1 text-[10px] text-[var(--c-text-muted)]">
          Le tunnel s'ouvre sans doute vers un port où rien n'écoute, ou la cible met très longtemps
          à répondre.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-rose-900/60 bg-rose-950/40 px-2.5 py-2">
      <p className="text-xs font-medium text-rose-300">La commande n'a pas établi de tunnel.</p>
      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-rose-200/80">{probe.message}</pre>
      {probe.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{probe.hint}</p>}
    </div>
  );
}

/** Ready-made proxy commands, inserted into the field as ordinary editable
 * text rather than hidden behind a provider setting.
 *
 * Each one is a program that relays bytes on stdin/stdout — that is the only
 * thing `ProxyCommand` requires, and the only thing these have in common.
 * They are shown rather than applied silently because the exact incantation
 * moves with each provider's CLI, and none of them can be verified from
 * inside the app: the user has to see the command line that will actually
 * run on their machine.
 *
 * Azure Bastion is deliberately absent — `az network bastion tunnel` opens a
 * local TCP port instead of relaying on stdio, so it isn't a proxy command at
 * all; it's used by pointing a host at 127.0.0.1 with the tunnel running. */
const PROXY_COMMAND_EXAMPLES: { label: string; hint: string; command: string }[] = [
  {
    label: "AWS SSM",
    hint: "instance EC2 sans IP publique — mettre l'id i-… en adresse",
    command: "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p",
  },
  {
    label: "GCP IAP",
    hint: "remplacer ZONE par la zone de l'instance",
    command: "gcloud compute start-iap-tunnel %h %p --listen-on-stdin --zone=ZONE",
  },
  {
    label: "Cloudflare",
    hint: "cloudflared access ssh",
    command: "cloudflared access ssh --hostname %h",
  },
  {
    label: "Bastion ssh -W",
    hint: "rebond par un hôte joignable en SSH, sans le déclarer dans l'app",
    command: "ssh -W %h:%p utilisateur@bastion.example.com",
  },
  {
    label: "netcat",
    hint: "simple relais TCP — utile pour vérifier que le mécanisme fonctionne",
    command: "nc %h %p",
  },
];

type AuthKind = "agent" | "password" | "privateKey" | "keyboardInteractive";

/**
 * Which radio/dropdown entry an existing host's auth corresponds to.
 *
 * Closed with `assertNever` rather than falling through to `"privateKey"`,
 * which is what it used to do: a method added to the union without a case here
 * would have been silently rendered as a private key, and the form would then
 * have *saved* it as one — turning a display gap into data loss. `tsc` now
 * refuses instead. Same shape of hole that shipped MongoDB unreachable.
 */
function authKindOf(auth: AuthMethod): AuthKind {
  if (typeof auth === "object") {
    if ("privateKey" in auth) return "privateKey";
    return assertNever(auth, "méthode d'authentification");
  }
  switch (auth) {
    case "password":
      return "password";
    case "agent":
      return "agent";
    case "keyboardInteractive":
      return "keyboardInteractive";
    default:
      return assertNever(auth, "méthode d'authentification");
  }
}

function jumpChoices(workspace: Workspace, editingId: HostId | null, chain: HostId[]): Host[] {
  return workspace.hosts.filter((h) => h.id !== editingId && !chain.includes(h.id));
}


export function HostForm({ workspace, host, defaultGroupId, onCancel, onSave, onDeleteHost, onWorkspaceUpdate }: HostFormProps) {
  const [label, setLabel] = useState(host?.label ?? "");
  const [kind, setKind] = useState<HostKind>(host?.kind ?? "ssh");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(host ? authKindOf(host.auth) : "agent");
  const initialKeyAuth = host && typeof host.auth === "object" && "privateKey" in host.auth ? host.auth.privateKey : null;
  const [keyPath, setKeyPath] = useState(initialKeyAuth?.path ?? "");
  const [keyId, setKeyId] = useState<KeyId | null>(initialKeyAuth?.keyId ?? null);
  const [certPath, setCertPath] = useState(initialKeyAuth?.certPath ?? "");
  /** Set when the conventional `<clé>-cert.pub` was found on disk and offered,
   * so the hint can say the field was filled in rather than typed. */
  const [certSuggested, setCertSuggested] = useState(false);
  const [secret, setSecret] = useState("");
  const [dockerViaHostId, setDockerViaHostId] = useState<HostId | "">(host?.dockerViaHostId ?? "");
  const [jumpVia, setJumpVia] = useState<HostId[]>(host?.jumpVia ?? []);
  const [proxyCommand, setProxyCommand] = useState(host?.proxyCommand ?? "");
  const [proxyProbe, setProxyProbe] = useState<ProxyProbe | null>(null);
  const [proxyProbing, setProxyProbing] = useState(false);
  // Cleared whenever the command changes: a result shown next to a command it
  // wasn't produced from is worse than no result at all.
  const setProxyCommandChecked = (value: string) => {
    setProxyCommand(value);
    setProxyProbe(null);
  };

  const runProxyProbe = () => {
    setProxyProbing(true);
    setProxyProbe(null);
    api.testProxyCommand(proxyCommand.trim(), address.trim(), Number(port) || 22, username.trim())
      .then(setProxyProbe)
      .catch((e) => setProxyProbe({ kind: "failed", message: String(e), hint: null }))
      .finally(() => setProxyProbing(false));
  };
  const [groupId, setGroupId] = useState<GroupId | "">(host?.groupId ?? defaultGroupId ?? "");
  const [tags, setTags] = useState<string[]>(host?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [startupSnippets, setStartupSnippets] = useState<SnippetId[]>(host?.startupSnippets ?? []);
  const [envVars, setEnvVars] = useState<EnvVar[]>(host?.envVars ?? []);
  const [keepalive, setKeepalive] = useState(String(host?.keepaliveIntervalSecs ?? 0));
  const [agentForward, setAgentForward] = useState(host?.agentForward ?? false);
  const [icon, setIcon] = useState<string | null>(host?.icon ?? null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<{ path: string } | null>(null);
  const [keyPromptName, setKeyPromptName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const choices = jumpChoices(workspace, host?.id ?? null, jumpVia);
  const snippetChoices = workspace.snippets.filter((s) => !startupSnippets.includes(s.id));
  const bastionChoices = workspace.hosts.filter((h) => (h.kind ?? "ssh") === "ssh" && h.id !== host?.id);

  // Field visibility per kind — see HostKind's doc comment in lib/types.ts for
  // which field each kind repurposes. Docker exec only needs the address
  // (daemon socket/host); Kubernetes exec needs address+username (context +
  // namespace) but nothing SSH-shaped; RDP is SSH-shaped minus bastions/
  // keepalive/agent-forward/startup-extras, and password-only auth.
  const showPort = kind === "ssh" || kind === "rdp";
  const showUsername = kind !== "dockerExec";
  const showAuthSection = kind === "ssh" || kind === "rdp";
  const sshOnlyExtras = kind === "ssh";
  // Startup snippets/env vars only need *some* POSIX-ish shell on the other
  // end to run against — true for SSH and Docker exec alike (both drive
  // `startup_commands` server-side, see `commands/terminal.rs`) — unlike
  // bastions/keepalive/agent-forward just above, which are SSH-protocol
  // concepts with no Docker-exec/K8s-exec equivalent. RDP has no shell at all.
  const shellExtras = kind === "ssh" || kind === "dockerExec" || kind === "k8sExec";
  const addressLabel = kind === "k8sExec" ? "Contexte kubeconfig" : kind === "dockerExec" ? "Socket / hôte Docker" : "Adresse";
  const addressPlaceholder = kind === "dockerExec" ? "unix:///var/run/docker.sock" : kind === "k8sExec" ? "ex: docker-desktop, prod-eu-west" : undefined;
  const usernameLabel = kind === "k8sExec" ? "Namespace par défaut" : "Utilisateur";

  const addStartupSnippet = (id: string) => { if (id) setStartupSnippets((prev) => [...prev, id]); };
  const removeStartupSnippet = (i: number) => setStartupSnippets((prev) => prev.filter((_, idx) => idx !== i));
  const moveSnippetUp = (i: number) => setStartupSnippets((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  const moveSnippetDown = (i: number) => setStartupSnippets((prev) => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });

  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  const removeEnvVar = (i: number) => setEnvVars((prev) => prev.filter((_, idx) => idx !== i));
  const setEnvKey = (i: number, key: string) => setEnvVars((prev) => prev.map((v, idx) => idx === i ? { ...v, key } : v));
  const setEnvValue = (i: number, value: string) => setEnvVars((prev) => prev.map((v, idx) => idx === i ? { ...v, value } : v));
  // Turning a variable secret keeps whatever is typed — it moves to the vault
  // on save. Turning it back clears it instead of revealing the stored value,
  // which the form doesn't have and shouldn't ask the backend for.
  const setEnvSecret = (i: number, secret: boolean) =>
    setEnvVars((prev) => prev.map((v, idx) => (idx === i ? { ...v, secret, value: secret ? v.value : "" } : v)));

  const browseKey = async () => {
    const selected = await open({ title: "Sélectionner une clé privée SSH", multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return;
    setKeyPath(selected);

    void offerCertificateFor(selected);

    const existing = workspace.keychain.find((k) => k.path === selected);
    if (existing) {
      setKeyId(existing.id);
      setKeyPrompt(null);
    } else {
      setKeyId(null);
      const fileName = selected.replace(/\\/g, "/").split("/").pop() ?? "";
      setKeyPromptName(fileName);
      setKeyPrompt({ path: selected });
    }
  };

  const confirmSaveKeyToKeychain = async () => {
    if (!keyPrompt) return;
    try {
      const ws = await api.addPrivateKey(keyPromptName.trim() || "Nouvelle clé", keyPrompt.path, null);
      const newKey = ws.keychain.find((k) => k.path === keyPrompt.path);
      if (newKey) setKeyId(newKey.id);
      onWorkspaceUpdate?.(ws);
    } catch (_e) { /* ignore */ }
    setKeyPrompt(null);
  };

  const pickKeychainKey = (kid: string) => {
    const k = workspace.keychain.find((k) => k.id === kid);
    if (k) { setKeyPath(k.path); setKeyId(k.id); void offerCertificateFor(k.path); }
    else { setKeyId(null); }
  };

  /** Fills the certificate field when `<clé>-cert.pub` is really there.
   *
   * Never overwrites something already typed: the convention is a good guess,
   * not a better answer than what the user chose. Silent on failure — this is
   * a convenience, and a machine with no certificate is the ordinary case, not
   * an error to report. */
  const offerCertificateFor = async (path: string) => {
    if (certPath.trim()) return;
    try {
      const found = await api.suggestCertificatePath(path);
      if (found) { setCertPath(found); setCertSuggested(true); }
    } catch (_e) { /* rien à dire : aucun certificat n'est le cas normal */ }
  };

  const browseCertificate = async () => {
    const selected = await open({ title: "Sélectionner un certificat SSH", multiple: false, directory: false });
    if (!selected || typeof selected !== "string") return;
    setCertPath(selected);
    setCertSuggested(false);
  };

  const addJump = (id: string) => { if (id) setJumpVia((prev) => [...prev, id]); };
  const removeJump = (i: number) => setJumpVia((prev) => prev.filter((_, idx) => idx !== i));
  const moveUp = (i: number) => setJumpVia((prev) => { const a = [...prev]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a; });
  const moveDown = (i: number) => setJumpVia((prev) => { const a = [...prev]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; });
  const addTag = () => {
    const value = tagInput.trim();
    if (value && !tags.includes(value)) setTags([...tags, value]);
    setTagInput("");
  };

  const submit = () => {
    if (!label.trim()) {
      setError("Le nom est requis");
      return;
    }

    if (kind === "dockerExec") {
      if (!address.trim() && !dockerViaHostId) {
        setError("Le socket/hôte Docker est requis (sauf en passant par un hôte SSH relais)");
        return;
      }
      onSave({
        id: host?.id ?? null, label: label.trim(), kind, address: address.trim(),
        port: 0, username: "", auth: "agent", dockerViaHostId: dockerViaHostId || null,
        jumpVia: [], proxyCommand: null, groupId: groupId || null,
        tags, startupSnippets, envVars: envVars.filter((v) => v.key.trim()), icon, secret: null,
        keepaliveIntervalSecs: null, agentForward: false,
      });
      return;
    }

    if (kind === "k8sExec") {
      if (!address.trim()) { setError("Le contexte kubeconfig est requis"); return; }
      onSave({
        id: host?.id ?? null, label: label.trim(), kind, address: address.trim(),
        port: 0, username: username.trim(), auth: "agent", dockerViaHostId: null,
        jumpVia: [], proxyCommand: null, groupId: groupId || null,
        tags, startupSnippets, envVars: envVars.filter((v) => v.key.trim()), icon, secret: null,
        keepaliveIntervalSecs: null, agentForward: false,
      });
      return;
    }

    // ssh / rdp — SSH-shaped fields, RDP just restricts auth to password and
    // drops the SSH-only extras below.
    if (!address.trim() || !username.trim()) {
      setError("Adresse et utilisateur sont requis");
      return;
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      setError("Port invalide");
      return;
    }
    if (kind === "ssh" && authKind === "privateKey" && !keyPath.trim()) {
      setError("Le chemin de la clé privée est requis");
      return;
    }

    // Both replace the transport, so a host carrying both is ambiguous —
    // OpenSSH treats ProxyCommand and ProxyJump as alternatives for the same
    // reason. Caught here rather than at connection time, where it would only
    // surface once the user tried to connect.
    if (sshOnlyExtras && proxyCommand.trim() && jumpVia.length > 0) {
      setError("Commande de proxy et chaîne de bastions sont incompatibles : gardez l'une ou l'autre");
      return;
    }

    const auth: AuthMethod = kind === "rdp"
      ? "password"
      : authKind === "privateKey"
        ? { privateKey: { path: keyPath.trim(), keyId, certPath: certPath.trim() || null } }
        // "agent" | "password" | "keyboardInteractive" map to themselves.
        : authKind;
    const keepaliveNum = Number(keepalive);

    onSave({
      id: host?.id ?? null,
      label: label.trim(),
      kind,
      address: address.trim(),
      port: portNum,
      username: username.trim(),
      auth,
      dockerViaHostId: null,
      jumpVia: sshOnlyExtras ? jumpVia : [],
      proxyCommand: sshOnlyExtras && proxyCommand.trim() ? proxyCommand.trim() : null,
      groupId: groupId || null,
      tags,
      startupSnippets: sshOnlyExtras ? startupSnippets : [],
      envVars: sshOnlyExtras ? envVars.filter((v) => v.key.trim()) : [],
      icon,
      secret: secret || null,
      keepaliveIntervalSecs: sshOnlyExtras && Number.isInteger(keepaliveNum) && keepaliveNum > 0 ? keepaliveNum : null,
      agentForward: sshOnlyExtras && authKind === "agent" && agentForward,
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      <div className="w-full space-y-4 rounded-xl bg-[var(--c-bg2)] p-5 shadow-[var(--shadow-md)]">
        <h2 className="text-[16px] font-semibold text-[var(--c-text)]">{host ? "Modifier l'hôte" : "Nouvel hôte"}</h2>

        {error && <p className="rounded-md bg-rose-950 px-3 py-2 text-sm text-rose-300">{error}</p>}

        <Field label="Nom">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Type de connexion">
          <div className="grid grid-cols-2 gap-1.5">
            {HOST_KINDS.map(({ key, label: kindLabel, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setKind(key);
                  if (key === "rdp") {
                    setAuthKind("password");
                    if (!host && port === "22") setPort("3389");
                  }
                }}
                className={`flex items-center justify-center gap-1.5 rounded-md border py-2 text-[13px] font-medium transition-all ${
                  kind === key ? "accent-surface" : "border-transparent bg-[var(--c-bg3)] text-[var(--c-text-secondary)] hover:bg-white/5"
                }`}
              >
                <Icon size={14} /> {kindLabel}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Icône">
          <div className="relative">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)]">
                {icon ? (
                  <HostIcon iconId={icon} customIcons={workspace.customIcons} size={24} />
                ) : (
                  <span className="text-lg text-[var(--c-text-muted)]">🖥</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowIconPicker((v) => !v)}
                className="rounded-md bg-[var(--c-bg3)] px-3 py-2 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
              >
                {icon ? "Changer l'icône" : "Choisir une icône"}
              </button>
              {icon && (
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className="rounded-md px-2 py-2 text-xs text-rose-400 hover:bg-rose-900/30"
                >
                  ✕
                </button>
              )}
            </div>
            {showIconPicker && (
              <IconPicker
                value={icon}
                customIcons={workspace.customIcons}
                onSelect={(id) => { setIcon(id); setShowIconPicker(false); }}
                onWorkspaceUpdate={(ws) => onWorkspaceUpdate?.(ws)}
                onClose={() => setShowIconPicker(false)}
              />
            )}
          </div>
        </Field>

        <Field label={addressLabel}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={dockerViaHostId ? "ignoré : voir l'hôte SSH relais ci-dessous" : addressPlaceholder}
            disabled={kind === "dockerExec" && !!dockerViaHostId}
            className={`${inputClass} font-mono disabled:opacity-40`}
          />
        </Field>
        {kind === "dockerExec" && (
          <p className="-mt-2 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
            Un démon Docker apparaît comme une seule entrée. Se connecter dessus liste les conteneurs en direct et laisse choisir la cible à exécuter.
          </p>
        )}
        {kind === "dockerExec" && (
          <Field label="Via un hôte SSH (bastion)">
            <HostTreePicker
              hosts={bastionChoices}
              groups={workspace.groups}
              customIcons={workspace.customIcons}
              value={dockerViaHostId}
              onChange={(v) => setDockerViaHostId((v ?? "") as HostId | "")}
              specials={[{ value: "", label: "Aucun", hint: "Connexion directe au socket/hôte ci-dessus" }]}
              className={`${inputClass} flex items-center justify-between gap-2 text-left`}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
              {dockerViaHostId
                ? "Le démon Docker par défaut de cet hôte SSH sera utilisé (docker system dial-stdio) — le champ socket/hôte ci-dessus est ignoré ; il faut juste que la commande docker soit installée côté distant."
                : "Utile quand le démon Docker distant n'expose pas de port TCP : passe par une session SSH déjà configurée plutôt que par le socket/hôte ci-dessus."}
            </p>
          </Field>
        )}
        {kind === "k8sExec" && (
          <p className="-mt-2 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
            Authentifié via kubeconfig, pas par adresse/port. Un cluster apparaît comme une seule entrée — la sélection du pod (et, s'il a plusieurs conteneurs, du conteneur) se fait au moment de la connexion.
          </p>
        )}
        {showPort && (
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={`${inputClass} font-mono`} />
          </Field>
        )}
        {showUsername && (
          <Field label={usernameLabel}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
          </Field>
        )}

        {sshOnlyExtras && (
          <Field label="Keepalive (secondes, 0 = désactivé)">
            <input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} inputMode="numeric" className={inputClass} />
          </Field>
        )}

        {showAuthSection && (
          <Field label="Authentification">
            <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className={inputClass}>
              {kind !== "rdp" && <option value="agent">Agent SSH</option>}
              <option value="password">Mot de passe</option>
              {kind !== "rdp" && <option value="privateKey">Clé privée</option>}
              {kind !== "rdp" && <option value="keyboardInteractive">Interactive (MFA / code à usage unique)</option>}
            </select>
            {authKind === "keyboardInteractive" && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--c-text-muted)]">
                Le serveur pose ses questions au moment de la connexion (code d'authentification,
                notification à valider…). Le mot de passe saisi ci-dessous, s'il y en a un, répond
                automatiquement à la première question masquée : vous n'aurez que le second facteur
                à taper.
              </p>
            )}
          </Field>
        )}
        {kind === "rdp" && (
          <p className="-mt-2 text-[11px] leading-relaxed text-[var(--c-text-muted)]">
            Ouvre le client RDP du système avec ces identifiants — pas de rendu intégré dans l'appli pour cette première version.
          </p>
        )}

        {showAuthSection && authKind === "agent" && (
          <label className="flex items-start gap-2 rounded-md bg-[var(--c-bg3)]/60 p-2.5">
            <input
              type="checkbox"
              checked={agentForward}
              onChange={(e) => setAgentForward(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]"
            />
            <span className="text-xs text-[var(--c-text-muted)]">
              <span className="font-medium text-[var(--c-text-secondary)]">Transférer l'agent SSH vers cet hôte</span>
              <br />
              L'hôte distant pourra utiliser vos clés locales pour rebondir ailleurs (ex. un autre bastion, un dépôt Git),
              sans qu'elles ne quittent votre machine. N'activez que pour des hôtes de confiance : un hôte compromis
              pourrait abuser de l'agent transféré pendant toute la durée de la session.
            </span>
          </label>
        )}

        {showAuthSection && authKind === "privateKey" && (
          <>
            {workspace.keychain.length > 0 && (
              <Field label="Clé du trousseau">
                <select
                  value={keyId ?? ""}
                  onChange={(e) => { if (e.target.value) pickKeychainKey(e.target.value); else { setKeyId(null); setKeyPath(""); } }}
                  className={inputClass}
                >
                  <option value="">(saisir un chemin manuellement)</option>
                  {workspace.keychain.map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Chemin de la clé privée">
              <div className="flex gap-1.5">
                <input
                  value={keyPath}
                  onChange={(e) => { setKeyPath(e.target.value); setKeyId(null); setKeyPrompt(null); }}
                  className={`${inputClass} flex-1 font-mono`}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button
                  type="button"
                  onClick={browseKey}
                  title="Parcourir le système de fichiers"
                  className="shrink-0 rounded-md bg-[var(--c-bg3)] px-2.5 py-2 text-sm text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  📂
                </button>
              </div>
              {keyId && !keyPrompt && (
                <p className="mt-1 text-[10px] text-[var(--c-accent-text)]">
                  🔑 Lié au trousseau : {workspace.keychain.find((k) => k.id === keyId)?.name ?? keyId}
                </p>
              )}
              {keyPrompt && (
                <div className="mt-2 space-y-2 rounded-md bg-[var(--c-accent-dim)] p-2.5">
                  <p className="text-xs text-[var(--c-accent-text)]">Enregistrer cette clé dans le trousseau ?</p>
                  <input
                    value={keyPromptName}
                    onChange={(e) => setKeyPromptName(e.target.value)}
                    placeholder="Nom de la clé"
                    className="w-full rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={confirmSaveKeyToKeychain}
                      className="flex-1 rounded-md bg-[var(--c-accent)] px-2 py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
                    >
                      Enregistrer dans le trousseau
                    </button>
                    <button
                      type="button"
                      onClick={() => setKeyPrompt(null)}
                      className="rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                    >
                      Sans enregistrer
                    </button>
                  </div>
                </div>
              )}
            </Field>
            {/* An addition to the key, not a replacement for it: the private
                key still signs, the certificate is what a CA-trusting server
                checks. Left empty on servers that list keys, which is most. */}
            <Field label="Certificat (optionnel)">
              <div className="flex gap-1.5">
                <input
                  value={certPath}
                  onChange={(e) => { setCertPath(e.target.value); setCertSuggested(false); }}
                  className={`${inputClass} flex-1 font-mono`}
                  placeholder="~/.ssh/id_ed25519-cert.pub"
                />
                <button
                  type="button"
                  onClick={browseCertificate}
                  title="Parcourir le système de fichiers"
                  className="shrink-0 rounded-md bg-[var(--c-bg3)] px-2.5 py-2 text-sm text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  📂
                </button>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--c-text-muted)]">
                {certSuggested
                  ? "🔎 Trouvé à côté de la clé. Relu à chaque connexion, donc un certificat renouvelé est pris en compte sans rien retoucher ici."
                  : "Pour les serveurs qui font confiance à une autorité (CA) au lieu de lister les clés. À laisser vide sinon."}
              </p>
            </Field>
          </>
        )}
        {showAuthSection && (authKind === "password" || authKind === "privateKey") && (
          <Field label={authKind === "password" ? "Mot de passe" : "Passphrase (optionnelle)"}>
            <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" className={inputClass} />
          </Field>
        )}

        {sshOnlyExtras && (
        <Field label="Chaîne de bastions">
          <div className="space-y-1 rounded-md bg-[var(--c-bg3)] p-2">
            {jumpVia.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Connexion directe (aucun bastion)</p>}
            {jumpVia.map((id, i) => {
              const h = workspace.hosts.find((host) => host.id === id);
              return (
                <div key={id} className="flex items-center gap-1.5 rounded bg-[var(--c-bg2)] px-2 py-1">
                  <span className="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-muted)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--c-text)]">{h?.label ?? id}</span>
                  <button type="button" onClick={() => moveUp(i)} disabled={i === 0} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↑</button>
                  <button type="button" onClick={() => moveDown(i)} disabled={i === jumpVia.length - 1} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↓</button>
                  <button type="button" onClick={() => removeJump(i)} className="px-0.5 text-rose-400 hover:text-rose-200">✕</button>
                </div>
              );
            })}
            {choices.length > 0 && (
              <HostTreePicker
                hosts={choices}
                groups={workspace.groups}
                customIcons={workspace.customIcons}
                value={null}
                onChange={(v) => { if (v) addJump(v); }}
                placeholder="+ Ajouter un bastion…"
                className="mt-1 flex w-full items-center justify-between gap-2 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-left text-sm text-[var(--c-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
              />
            )}
          </div>
        </Field>
        )}

        {sshOnlyExtras && (
        <Field label="Commande de proxy">
          <div className="space-y-1.5">
            <textarea
              value={proxyCommand}
              onChange={(e) => setProxyCommandChecked(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="Connexion directe (aucune commande de proxy)"
              className="w-full resize-y rounded-md bg-[var(--c-bg3)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
            />
            <p className="text-xs leading-relaxed text-[var(--c-text-muted)]">
              Lance ce programme et parle SSH sur son entrée/sortie standard au lieu de se connecter
              directement à l'adresse — c'est ainsi qu'on atteint une machine sans IP publique ni SSH
              entrant. <code className="text-[var(--c-text-secondary)]">%h</code> adresse,{" "}
              <code className="text-[var(--c-text-secondary)]">%p</code> port,{" "}
              <code className="text-[var(--c-text-secondary)]">%r</code> utilisateur.
            </p>
            {proxyCommand.trim() && jumpVia.length > 0 && (
              <p className="text-xs text-amber-400">
                Incompatible avec la chaîne de bastions ci-dessus : les deux remplacent le transport.
              </p>
            )}
            {proxyCommand.trim() && (
              <button
                type="button"
                onClick={runProxyProbe}
                disabled={proxyProbing || !address.trim()}
                className="rounded-md border border-[var(--c-border)] px-2.5 py-1 text-xs text-[var(--c-text-secondary)] hover:border-[var(--c-accent)] hover:text-[var(--c-text)] disabled:opacity-50"
              >
                {proxyProbing ? "Test en cours…" : "Tester la commande"}
              </button>
            )}
            {proxyProbe && <ProxyProbeResult probe={proxyProbe} />}
            <details className="rounded-md bg-[var(--c-bg3)] px-2 py-1.5">
              <summary className="cursor-pointer select-none text-xs text-[var(--c-text-secondary)] hover:text-[var(--c-text)]">
                Exemples — cliquer pour insérer
              </summary>
              <div className="mt-1.5 space-y-1">
                {PROXY_COMMAND_EXAMPLES.map((example) => (
                  <button
                    key={example.label}
                    type="button"
                    onClick={() => setProxyCommandChecked(example.command)}
                    title={example.command}
                    className="block w-full rounded bg-[var(--c-bg2)] px-2 py-1.5 text-left hover:bg-[var(--c-bg)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                  >
                    <span className="text-xs font-medium text-[var(--c-text)]">{example.label}</span>
                    <span className="ml-1.5 text-[10px] text-[var(--c-text-muted)]">{example.hint}</span>
                    <code className="mt-0.5 block truncate font-mono text-[10px] text-[var(--c-text-secondary)]">
                      {example.command}
                    </code>
                  </button>
                ))}
              </div>
            </details>
          </div>
        </Field>
        )}

        <Field label="Dossier">
          <GroupTreePicker
            groups={workspace.groups}
            value={groupId || null}
            onChange={(id) => setGroupId(id ?? "")}
            customIcons={workspace.customIcons}
          />
        </Field>

        {shellExtras && (
        <Field label="Snippets au démarrage">
          <div className="space-y-1 rounded-md bg-[var(--c-bg3)] p-2">
            {startupSnippets.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Aucun snippet au démarrage</p>}
            {startupSnippets.map((id, i) => {
              const s = workspace.snippets.find((sn) => sn.id === id);
              return (
                <div key={id} className="flex items-center gap-1.5 rounded bg-[var(--c-bg2)] px-2 py-1">
                  <span className="w-4 shrink-0 text-center text-[10px] text-[var(--c-text-muted)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--c-text)]">{s?.name ?? id}</span>
                  <button type="button" onClick={() => moveSnippetUp(i)} disabled={i === 0} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↑</button>
                  <button type="button" onClick={() => moveSnippetDown(i)} disabled={i === startupSnippets.length - 1} className="px-0.5 text-[var(--c-text-secondary)] disabled:opacity-20 hover:text-[var(--c-text)]">↓</button>
                  <button type="button" onClick={() => removeStartupSnippet(i)} className="px-0.5 text-rose-400 hover:text-rose-200">✕</button>
                </div>
              );
            })}
            {snippetChoices.length > 0 && (
              <select value="" onChange={(e) => addStartupSnippet(e.target.value)} className="mt-1 w-full rounded-md bg-[var(--c-bg2)] px-2 py-1.5 text-sm text-[var(--c-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]">
                <option value="" disabled>+ Ajouter un snippet…</option>
                {snippetChoices.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>
        </Field>
        )}

        {shellExtras && (
        <Field label="Variables d'environnement">
          <div className="space-y-1.5 rounded-md bg-[var(--c-bg3)] p-2">
            {envVars.length === 0 && <p className="py-0.5 text-xs text-[var(--c-text-muted)]">Aucune variable définie</p>}
            {envVars.map((v, i) => {
              // A stored secret is never sent back to the form, so an empty
              // value on an already-saved secret means "unchanged" — the
              // placeholder has to say that, or it reads as "lost".
              const storedSecret = v.secret && !v.value && (host?.envVars ?? []).some((s) => s.key === v.key && s.secret);
              return (
                <div key={i} className="flex gap-1.5">
                  <input
                    value={v.key}
                    onChange={(e) => setEnvKey(i, e.target.value)}
                    placeholder="NOM"
                    className="w-28 shrink-0 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                  />
                  <input
                    value={v.value}
                    onChange={(e) => setEnvValue(i, e.target.value)}
                    type={v.secret ? "password" : "text"}
                    placeholder={storedSecret ? "enregistrée — laisser vide pour conserver" : "valeur"}
                    className="min-w-0 flex-1 rounded-md bg-[var(--c-bg2)] px-2 py-1.5 font-mono text-xs text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                  />
                  <button
                    type="button"
                    onClick={() => setEnvSecret(i, !v.secret)}
                    title={v.secret
                      ? "Valeur gardée dans le coffre (trousseau OS ou coffre chiffré) — cliquer pour la remettre en clair dans workspace.json"
                      : "Garder cette valeur dans le coffre plutôt qu'en clair dans workspace.json"}
                    className={`shrink-0 rounded-md px-1.5 text-xs transition-colors ${
                      v.secret ? "bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]"
                    }`}
                  >
                    {v.secret ? "🔒" : "🔓"}
                  </button>
                  <button type="button" onClick={() => removeEnvVar(i)} className="shrink-0 px-1.5 text-rose-400 hover:text-rose-200">✕</button>
                </div>
              );
            })}
            <p className="pt-0.5 text-[10px] leading-relaxed text-[var(--c-text-faint)]">
              🔒 met la valeur au coffre au lieu de <span className="font-mono">workspace.json</span> — pour un jeton d'API,
              pas pour <span className="font-mono">LANG</span>.
            </p>
            <button type="button" onClick={addEnvVar} className="mt-0.5 w-full rounded-md bg-[var(--c-bg2)]/60 py-1 text-xs text-[var(--c-text-muted)] hover:bg-[var(--c-bg2)] hover:text-[var(--c-text-secondary)]">
              + Ajouter une variable
            </button>
          </div>
        </Field>
        )}

        <Field label="Étiquettes">
          <div className="flex flex-wrap gap-1.5 rounded-md bg-[var(--c-bg3)] p-2">
            {tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded-full bg-[var(--c-accent-dim)] px-2 py-0.5 text-xs text-[var(--c-accent-text)]">
                {tag}
                <button onClick={() => setTags(tags.filter((t) => t !== tag))} className="text-[var(--c-accent-text)] hover:text-white">
                  ✕
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="Ajouter une étiquette…"
              className="min-w-[8rem] flex-1 bg-transparent text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)]"
            />
          </div>
        </Field>

        <div className="flex gap-2 pt-2">
          <button onClick={submit} className="flex-1 rounded-md bg-[var(--c-accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--c-accent-hover)]">
            Enregistrer
          </button>
          <button onClick={onCancel} className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text-secondary)] hover:bg-white/5">
            Annuler
          </button>
        </div>

        {host && onDeleteHost && (
          <div className="pt-3">
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg bg-rose-950/30 p-3">
                <p className="text-sm text-rose-300">Supprimer cet hôte définitivement ?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => onDeleteHost(host.id)}
                    className="flex-1 rounded-md bg-rose-700 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600"
                  >
                    Oui, supprimer
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm font-medium text-[var(--c-text-secondary)] hover:bg-white/5"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm text-rose-400 hover:bg-rose-950/40 hover:text-rose-300"
              >
                <IconTrash size={13} /> Supprimer cet hôte
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-md bg-[var(--c-bg3)] px-3 py-2 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--c-text-muted)]">{label}</span>
      {children}
    </label>
  );
}
