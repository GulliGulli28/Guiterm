import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, type SaveHostInput } from "../lib/api";
import { IconClose, IconEye, IconEyeOff, IconFolder, IconHosts, IconKeychain, IconLock, IconUnlock, IconPlus, IconCopy, IconPlay, IconTunnels, IconTerminal, IconCheck, IconWarning } from "./ui-icons";
import type { AuthMethod, ConnectionTest, EnvVar, GroupId, GuiVaultVault, Host, HostId, HostKind, KeyId, PersistentShellMode, ProxyProbe, SnippetId, VaultId, Workspace } from "../lib/types";
import { HostIcon } from "./icons";
import { IconPicker } from "./IconPicker";
import { GroupTreePicker } from "./GroupTreePicker";
import { ReadOnlyVaultNotice, VaultField, readOnlyVault } from "./VaultField";
import { HostTreePicker } from "./HostTreePicker";
import { HOST_KINDS, hostKindMeta } from "../lib/hostKinds";
import { assertNever } from "../lib/exhaustive";
import { secretSlot, secretToSave, type AuthKind, type StoredSecretsState } from "../lib/hostSecret";
import { groupPath } from "../lib/hostTree";
import { sshCommandLine } from "../lib/sshCommand";
import { DrawerDeleteButton, DrawerSaveButton, Field, FieldGroup, FormDrawer, type FormSection } from "./FormDrawer";
import { SECTION_LABELS, STAGE_LABELS, sectionForStage, sectionsFor, type HostFormSection } from "../lib/hostFormSections";

interface HostFormProps {
  workspace: Workspace;
  host: Host | null;
  defaultGroupId?: GroupId | null;
  /** Les vaults GuiVault du compte connecté — vide sans compte : le champ
   * « Vault » n'apparaît alors pas. */
  vaults?: GuiVaultVault[];
  /** Affiliation actuelle de l'hôte (`null` = vault personnel). */
  vaultId?: VaultId | null;
  onCancel: () => void;
  onSave: (input: SaveHostInput & {
    /** `undefined` quand le champ n'était pas proposé ; `null` = personnel. */
    vaultId?: VaultId | null;
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
      <div className="callout callout-ok">
        <p className="text-xs font-medium text-[var(--c-ok)]">Le tunnel s'ouvre et un serveur SSH répond.</p>
        <code className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--c-ok)]">{probe.banner}</code>
        <p className="mt-1 text-[10.5px] text-[var(--c-text-muted)]">
          L'authentification n'est pas testée : « Tester la connexion » le fait.
        </p>
      </div>
    );
  }
  if (probe.kind === "silent") {
    return (
      <div className="callout callout-warn">
        <p className="text-xs font-medium text-[var(--c-warn)]">La commande tourne, mais rien ne répond.</p>
        <p className="mt-1 text-[10.5px] text-[var(--c-text-muted)]">
          Le tunnel mène sans doute à un port où rien n'écoute.
        </p>
      </div>
    );
  }
  return (
    <div className="callout callout-danger">
      <p className="text-xs font-medium text-[var(--c-danger)]">La commande n'a pas établi de tunnel.</p>
      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] text-[var(--c-danger)]">{probe.message}</pre>
      {probe.hint && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--c-text-secondary)]">{probe.hint}</p>}
    </div>
  );
}

/** Le verdict de « Tester la connexion », sous la commande équivalente. */
function ConnectionTestResult({ result, stale, onOpenSection }: {
  result: ConnectionTest;
  /** Les champs ont changé depuis l'essai. */
  stale: boolean;
  onOpenSection: (section: HostFormSection) => void;
}) {
  const ago = stale ? <p className="text-[11px] text-[var(--c-text-muted)]">Obtenu avant vos dernières modifications.</p> : null;
  if (result.kind === "connected") {
    const via = result.bastions === 0 ? "" : result.bastions === 1 ? " via 1 bastion" : ` via ${result.bastions} bastions`;
    return (
      <div data-connection-test="connected" className={`callout callout-ok space-y-1 ${stale ? "opacity-60" : ""}`}>
        <p className="flex items-center gap-2 font-medium text-[var(--c-ok)]">
          <IconCheck size={13} /> Connexion réussie en {result.elapsedMs} ms{via}
        </p>
        {ago}
        {result.hostKey && (
          <p className="text-[11.5px] text-[var(--c-text-secondary)]">
            {result.hostKey.known ? "Empreinte connue" : "Nouvelle empreinte, approuvée à la première vraie connexion"}
            {" · "}<span className="font-mono text-[11px]">{result.hostKey.fingerprint}</span>
          </p>
        )}
      </div>
    );
  }
  const section = sectionForStage(result.stage);
  return (
    <div data-connection-test="failed" data-stage={result.stage} className={`callout callout-danger space-y-1.5 ${stale ? "opacity-60" : ""}`}>
      <p className="flex items-center gap-2 font-medium text-[var(--c-danger)]">
        <IconWarning size={13} /> Échec à l'étape « {STAGE_LABELS[result.stage]} » — {result.host}
      </p>
      {ago}
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--c-text-secondary)]">{result.message}</pre>
      {section && (
        <button type="button" onClick={() => onOpenSection(section)} className="btn btn-secondary btn-sm">
          Vérifier la section {SECTION_LABELS[section]}
        </button>
      )}
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

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

const fileName = (path: string) => path.replace(/\\/g, "/").split("/").pop() ?? path;

export function HostForm({ workspace, host, defaultGroupId, vaults = [], vaultId: initialVaultId = null, onCancel, onSave, onDeleteHost, onWorkspaceUpdate }: HostFormProps) {
  const [section, setSection] = useState<HostFormSection>("connexion");
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
  // Le mot de passe et la passphrase ont chacun leur champ : un même état
  // pour les deux faisait suivre le texte tapé d'une méthode à l'autre.
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);
  /** Ce que le coffre enregistre pour cet hôte, lu à l'ouverture : « loaded »
   * quand les champs affichent la valeur enregistrée (un champ vidé l'efface
   * alors), « unavailable » quand le coffre n'a pas pu répondre (verrouillé),
   * et un champ vide veut alors dire « ne pas toucher ». */
  const [storedSecrets, setStoredSecrets] = useState<{ state: Exclude<StoredSecretsState, "unavailable"> } | { state: "unavailable"; reason: string }>(
    host ? { state: "loading" } : { state: "loaded" },
  );
  const hostId = host?.id ?? null;
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    api.getHostSecrets(hostId)
      .then((s) => {
        if (cancelled) return;
        setPassword(s?.password ?? "");
        setPassphrase(s?.passphrase ?? "");
        setStoredSecrets({ state: "loaded" });
      })
      .catch((e) => { if (!cancelled) setStoredSecrets({ state: "unavailable", reason: String(e) }); });
    return () => { cancelled = true; };
  }, [hostId]);
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
  const [vaultId, setVaultId] = useState<VaultId | "">(initialVaultId ?? "");
  const sharedVaults = vaults.filter((v) => v.kind === "shared");
  // Sans droit d'écriture, l'hôte se voit mais ne se modifie pas — et il ne
  // se déplace pas non plus vers un autre vault (ce serait une suppression).
  const currentVault = readOnlyVault(vaults, initialVaultId);
  const vaultReadOnly = currentVault !== null;
  const vaultField = sharedVaults.length > 0 || vaultId !== "" ? { vaultId: vaultId || null } : {};
  const [tags, setTags] = useState<string[]>(host?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [startupSnippets, setStartupSnippets] = useState<SnippetId[]>(host?.startupSnippets ?? []);
  const [envVars, setEnvVars] = useState<EnvVar[]>(host?.envVars ?? []);
  const [keepalive, setKeepalive] = useState(String(host?.keepaliveIntervalSecs ?? 0));
  const [agentForward, setAgentForward] = useState(host?.agentForward ?? false);
  const [persistentShell, setPersistentShell] = useState<PersistentShellMode>(host?.persistentShell ?? "off");
  const [icon, setIcon] = useState<string | null>(host?.icon ?? null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<{ path: string } | null>(null);
  const [keyPromptName, setKeyPromptName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Le dernier essai, et ce qu'il a essayé (pour dire quand les champs ont
   * bougé depuis). */
  const [test, setTest] = useState<{ result: ConnectionTest; signature: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

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
  const sshOnlyExtras = kind === "ssh";
  const visibleSections = sectionsFor(kind);
  const activeSection = visibleSections.includes(section) ? section : "connexion";
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
      setKeyPromptName(fileName(selected));
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

  /** Ce que le formulaire décrit, ou le premier champ à corriger — et la
   * section où il se trouve. Partagé par Enregistrer et Tester. */
  const build = (): { ok: true; input: SaveHostInput } | { ok: false; error: string; section: HostFormSection } => {
    if (!label.trim()) return { ok: false, error: "Le nom est requis", section: "connexion" };
    const common = {
      id: host?.id ?? null, label: label.trim(), kind, groupId: groupId || null, tags, icon,
    };

    if (kind === "dockerExec") {
      if (!address.trim() && !dockerViaHostId) {
        return { ok: false, error: "Le socket/hôte Docker est requis (sauf en passant par un hôte SSH relais)", section: "connexion" };
      }
      return { ok: true, input: {
        ...common, address: address.trim(),
        port: 0, username: "", auth: "agent", dockerViaHostId: dockerViaHostId || null,
        jumpVia: [], proxyCommand: null,
        startupSnippets, envVars: envVars.filter((v) => v.key.trim()), secret: null,
        keepaliveIntervalSecs: null, agentForward: false, persistentShell: "off",
      } };
    }

    if (kind === "k8sExec") {
      if (!address.trim()) return { ok: false, error: "Le contexte kubeconfig est requis", section: "connexion" };
      return { ok: true, input: {
        ...common, address: address.trim(),
        port: 0, username: username.trim(), auth: "agent", dockerViaHostId: null,
        jumpVia: [], proxyCommand: null,
        startupSnippets, envVars: envVars.filter((v) => v.key.trim()), secret: null,
        keepaliveIntervalSecs: null, agentForward: false, persistentShell: "off",
      } };
    }

    // ssh / rdp — SSH-shaped fields, RDP just restricts auth to password and
    // drops the SSH-only extras below.
    if (!address.trim() || !username.trim()) return { ok: false, error: "Adresse et utilisateur sont requis", section: "connexion" };
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return { ok: false, error: "Port invalide", section: "connexion" };
    if (kind === "ssh" && authKind === "privateKey" && !keyPath.trim()) {
      return { ok: false, error: "Le chemin de la clé privée est requis", section: "auth" };
    }

    // Both replace the transport, so a host carrying both is ambiguous —
    // OpenSSH treats ProxyCommand and ProxyJump as alternatives for the same
    // reason. Caught here rather than at connection time, where it would only
    // surface once the user tried to connect.
    if (sshOnlyExtras && proxyCommand.trim() && jumpVia.length > 0) {
      return { ok: false, error: "Commande de proxy et chaîne de bastions sont incompatibles : gardez l'une ou l'autre", section: "reseau" };
    }

    const auth: AuthMethod = kind === "rdp"
      ? "password"
      : authKind === "privateKey"
        ? { privateKey: { path: keyPath.trim(), keyId, certPath: certPath.trim() || null } }
        // "agent" | "password" | "keyboardInteractive" map to themselves.
        : authKind;
    const keepaliveNum = Number(keepalive);
    const slot = secretSlot(kind, authKind, keyId);
    const secret = secretToSave(slot === "password" ? password : slot === "passphrase" ? passphrase : null, storedSecrets.state);

    return { ok: true, input: {
      ...common,
      address: address.trim(),
      port: portNum,
      username: username.trim(),
      auth,
      dockerViaHostId: null,
      jumpVia: sshOnlyExtras ? jumpVia : [],
      proxyCommand: sshOnlyExtras && proxyCommand.trim() ? proxyCommand.trim() : null,
      startupSnippets: sshOnlyExtras ? startupSnippets : [],
      envVars: sshOnlyExtras ? envVars.filter((v) => v.key.trim()) : [],
      secret,
      keepaliveIntervalSecs: sshOnlyExtras && Number.isInteger(keepaliveNum) && keepaliveNum > 0 ? keepaliveNum : null,
      agentForward: sshOnlyExtras && authKind === "agent" && agentForward,
      persistentShell: sshOnlyExtras ? persistentShell : "off",
    } };
  };

  const built = build();

  const fail = (result: { error: string; section: HostFormSection }) => {
    setError(result.error);
    setSection(result.section);
  };

  const submit = () => {
    if (!built.ok) return fail(built);
    onSave({ ...built.input, ...vaultField });
  };

  /** Ce qu'un essai compare : tout ce qui part vers le serveur. */
  const signature = built.ok ? JSON.stringify(built.input) : "";

  const runTest = () => {
    if (!built.ok) return fail(built);
    setError(null);
    setTesting(true);
    const sent = signature;
    api.testHostConnection(built.input)
      .then((result) => setTest({ result, signature: sent }))
      .catch((e) => setTest({ result: { kind: "failed", stage: "handshake", host: label.trim(), message: String(e), elapsedMs: 0 }, signature: sent }))
      .finally(() => setTesting(false));
  };

  const commandLine = kind === "ssh" && address.trim()
    ? sshCommandLine({
        address: address.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        auth: authKind === "privateKey" ? { privateKey: { path: keyPath.trim(), keyId, certPath: certPath.trim() || null } } : authKind,
        jumpVia,
        proxyCommand,
        agentForward: authKind === "agent" && agentForward,
        keepaliveIntervalSecs: Number(keepalive) || null,
      }, workspace.hosts)
    : null;

  const copyCommand = () => {
    if (!commandLine) return;
    writeText(commandLine).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  // ── Résumés de la navigation ────────────────────────────────────────────
  const keyName = keyId ? workspace.keychain.find((k) => k.id === keyId)?.name : null;
  const authSummary = kind === "rdp" ? "Mot de passe" : (() => {
    switch (authKind) {
      case "agent": return agentForward ? "Agent SSH · transféré" : "Agent SSH";
      case "password": return "Mot de passe";
      case "keyboardInteractive": return "Interactive (MFA)";
      case "privateKey": return `Clé · ${keyName ?? (keyPath.trim() ? fileName(keyPath.trim()) : "à choisir")}${certPath.trim() ? " · certificat" : ""}`;
      default: return assertNever(authKind, "méthode d'authentification");
    }
  })();
  const keepaliveNum = Number(keepalive);
  const networkSummary = [
    proxyCommand.trim() ? "Commande de proxy" : jumpVia.length ? plural(jumpVia.length, "bastion", "bastions") : "Directe",
    keepaliveNum > 0 ? `keepalive ${keepaliveNum} s` : null,
  ].filter(Boolean).join(" · ");
  const sessionSummary = [
    kind === "ssh" ? (persistentShell === "tmux" ? "tmux" : "Shell neuf") : null,
    startupSnippets.length ? plural(startupSnippets.length, "snippet", "snippets") : null,
    envVars.filter((v) => v.key.trim()).length ? plural(envVars.filter((v) => v.key.trim()).length, "variable", "variables") : null,
  ].filter(Boolean).join(" · ") || "Rien au démarrage";
  const folderPath = groupPath(workspace.groups, groupId || null);
  const vaultName = vaults.find((v) => v.id === (vaultId || initialVaultId))?.name ?? null;
  const organisationSummary = [
    folderPath.length ? folderPath[folderPath.length - 1] : "Racine",
    tags.length ? plural(tags.length, "étiquette", "étiquettes") : null,
  ].filter(Boolean).join(" · ");
  const kindMeta = hostKindMeta(kind);
  const dockerVia = dockerViaHostId ? workspace.hosts.find((h) => h.id === dockerViaHostId)?.label : null;
  const connectionSummary = `${kindMeta.label} · ${dockerVia ? `via ${dockerVia}` : address.trim() || "adresse à saisir"}`;

  const SECTIONS: Record<HostFormSection, FormSection<HostFormSection>> = {
    connexion: { id: "connexion", label: "Connexion", icon: <IconHosts size={13} />, summary: connectionSummary },
    auth: { id: "auth", label: "Authentification", icon: <IconKeychain size={13} />, summary: authSummary },
    reseau: { id: "reseau", label: "Réseau", icon: <IconTunnels size={13} />, summary: networkSummary },
    session: { id: "session", label: "Session", icon: <IconTerminal size={13} />, summary: sessionSummary },
    organisation: { id: "organisation", label: "Organisation", icon: <IconFolder size={13} />, summary: organisationSummary },
  };

  const subtitle = (
    <>
      {vaultName && <span className="truncate">{vaultName}</span>}
      {vaultName && <span aria-hidden="true">·</span>}
      <span className="truncate">{folderPath.length ? folderPath.join(" › ") : "Racine"}</span>
    </>
  );

  const renderConnexion = () => (
    <div className="space-y-4">
      <FieldGroup label="Type de connexion">
        <div role="radiogroup" className="segmented flex w-full">
          {HOST_KINDS.map(({ key, label: kindLabel, short, Icon }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={kind === key}
              data-active={kind === key}
              onClick={() => {
                setKind(key);
                if (key === "rdp") {
                  setAuthKind("password");
                  if (!host && port === "22") setPort("3389");
                }
              }}
              title={kindLabel}
              className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Icon size={13} /> {short}
            </button>
          ))}
        </div>
      </FieldGroup>

      <div className="grid grid-cols-[56px_minmax(0,1fr)] items-end gap-3">
        <div className="relative">
          <span className="field-label">Icône</span>
          <button
            type="button"
            onClick={() => setShowIconPicker((v) => !v)}
            aria-label={icon ? "Changer l'icône" : "Choisir une icône"}
            title={icon ? "Changer l'icône" : "Choisir une icône"}
            className="flex h-[30px] w-[56px] items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-muted)] hover:border-[var(--c-border-strong)]"
          >
            {icon ? <HostIcon iconId={icon} customIcons={workspace.customIcons} size={18} /> : <kindMeta.Icon size={15} />}
          </button>
          {icon && (
            <button type="button" onClick={() => setIcon(null)} className="mt-1 text-[11px] text-[var(--c-text-muted)] hover:text-[var(--c-text)]">
              Retirer
            </button>
          )}
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
        <Field label="Nom">
          <input value={label} onChange={(e) => setLabel(e.target.value)} data-autofocus={host ? undefined : true} className="input" />
        </Field>
      </div>

      <div className={showPort ? "grid grid-cols-[minmax(0,1fr)_96px] gap-3" : ""}>
        <Field label={addressLabel}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={dockerViaHostId ? "ignoré : l'hôte SSH relais ci-dessous" : addressPlaceholder}
            disabled={kind === "dockerExec" && !!dockerViaHostId}
            className="input input-mono disabled:opacity-40"
          />
        </Field>
        {showPort && (
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="input input-mono" />
          </Field>
        )}
      </div>
      {kind === "dockerExec" && (
        <p className="help-text -mt-2">Les conteneurs sont listés à la connexion.</p>
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
            className="input flex items-center justify-between gap-2 text-left"
          />
          <p className="help-text mt-1" title="docker system dial-stdio : la commande docker doit être installée côté distant.">
            {dockerViaHostId
              ? "Le démon Docker par défaut de cet hôte SSH est utilisé ; le socket ci-dessus est ignoré."
              : "Pour un démon Docker qui n'expose pas de port TCP."}
          </p>
        </Field>
      )}
      {kind === "k8sExec" && (
        <p className="help-text -mt-2" title="Un cluster apparaît comme une seule entrée : le pod, et son conteneur s'il en a plusieurs, se choisissent au moment de la connexion.">
          Authentifié par kubeconfig. Le pod se choisit à la connexion.
        </p>
      )}
      {showUsername && (
        <Field label={usernameLabel}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={`input ${kind === "k8sExec" ? "" : "input-mono"}`} />
        </Field>
      )}
    </div>
  );

  const renderAuth = () => (
    <div className="space-y-4">
      {kind === "rdp" ? (
        <p className="help-text">Les identifiants du compte Windows, utilisés par l'aperçu intégré.</p>
      ) : (
        <Field label="Authentification">
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)} className="input">
            <option value="agent">Agent SSH</option>
            <option value="password">Mot de passe</option>
            <option value="privateKey">Clé privée</option>
            <option value="keyboardInteractive">Interactive (MFA / code à usage unique)</option>
          </select>
          {authKind === "keyboardInteractive" && (
            <p className="help-text mt-1.5" title="Le mot de passe saisi ci-dessous, s'il y en a un, répond tout seul à la première question masquée du serveur.">
              Le serveur pose ses questions à la connexion ; vous ne tapez que le second facteur.
            </p>
          )}
        </Field>
      )}

      {/* Le transfert d'agent n'a de sens qu'en SSH — RDP n'a pas d'agent. */}
      {kind === "ssh" && authKind === "agent" && (
        <label className="card flex items-start gap-2 p-2.5">
          <input
            type="checkbox"
            checked={agentForward}
            onChange={(e) => setAgentForward(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span
            className="help-text"
            title="L'hôte distant pourra utiliser vos clés locales pour rebondir ailleurs (un autre bastion, un dépôt Git), sans qu'elles quittent votre machine. Un hôte compromis pourrait s'en servir pendant toute la session."
          >
            <span className="font-medium text-[var(--c-text-secondary)]">Transférer l'agent SSH vers cet hôte</span>
            <br />
            À réserver aux hôtes de confiance.
          </span>
        </label>
      )}

      {kind === "ssh" && authKind === "privateKey" && (
        <>
          {workspace.keychain.length > 0 && (
            <Field label="Clé du trousseau">
              <select
                value={keyId ?? ""}
                onChange={(e) => { if (e.target.value) pickKeychainKey(e.target.value); else { setKeyId(null); setKeyPath(""); } }}
                className="input"
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
                className="input input-mono flex-1"
                placeholder="~/.ssh/id_ed25519"
              />
              <button type="button" onClick={browseKey} title="Parcourir le système de fichiers" aria-label="Parcourir" className="btn btn-secondary btn-icon">
                <IconFolder size={13} />
              </button>
            </div>
            {keyId && !keyPrompt && (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-[var(--c-accent-text)]">
                <IconKeychain size={11} /> Lié au trousseau : {keyName ?? keyId}
              </p>
            )}
            {keyPrompt && (
              <div className="card mt-2 space-y-2 p-2.5">
                <p className="text-[12px] font-medium text-[var(--c-text)]">Enregistrer cette clé dans le trousseau ?</p>
                <input
                  value={keyPromptName}
                  onChange={(e) => setKeyPromptName(e.target.value)}
                  placeholder="Nom de la clé"
                  className="input w-full"
                />
                <div className="flex gap-1.5">
                  <button type="button" onClick={confirmSaveKeyToKeychain} className="btn btn-primary flex-1">
                    Enregistrer dans le trousseau
                  </button>
                  <button type="button" onClick={() => setKeyPrompt(null)} className="btn btn-ghost">
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
                className="input input-mono flex-1"
                placeholder="~/.ssh/id_ed25519-cert.pub"
              />
              <button type="button" onClick={browseCertificate} title="Parcourir le système de fichiers" aria-label="Parcourir" className="btn btn-secondary btn-icon">
                <IconFolder size={13} />
              </button>
            </div>
            <p className="help-text mt-1" title="Relu à chaque connexion : un certificat renouvelé est pris en compte sans rien retoucher ici.">
              {certSuggested
                ? "Trouvé à côté de la clé."
                : "Pour un serveur qui fait confiance à une autorité (CA). Sinon, à laisser vide."}
            </p>
          </Field>
        </>
      )}
      {secretSlot(kind, authKind, keyId) !== null && (() => {
        const isPassword = secretSlot(kind, authKind, keyId) === "password";
        const value = isPassword ? password : passphrase;
        const setValue = isPassword ? setPassword : setPassphrase;
        const noun = isPassword ? "le mot de passe" : "la passphrase";
        return (
          <Field label={isPassword ? "Mot de passe" : "Passphrase (optionnelle)"}>
            <div className="flex gap-1.5">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                type={revealSecret ? "text" : "password"}
                autoComplete="off"
                data-testid="host-secret"
                className="input min-w-0 flex-1"
                placeholder={storedSecrets.state === "unavailable" ? "(conservé tel quel)" : undefined}
              />
              <button
                type="button"
                onClick={() => setRevealSecret((v) => !v)}
                title={revealSecret ? `Cacher ${noun}` : `Afficher ${noun}`}
                aria-label={revealSecret ? `Cacher ${noun}` : `Afficher ${noun}`}
                aria-pressed={revealSecret}
                className="btn btn-secondary btn-icon text-[var(--c-text-muted)]"
              >
                {revealSecret ? <IconEyeOff size={13} /> : <IconEye size={13} />}
              </button>
            </div>
            {/* Ce que le champ montre est ce que la connexion utilisera :
                dire d'où ça vient évite de confondre « rien d'enregistré »
                et « enregistré mais masqué ». */}
            {host && storedSecrets.state === "loaded" && (
              <p className="help-text mt-1">
                {value
                  ? `C'est ${noun} enregistré${isPassword ? "" : "e"}. Vidé, il sera effacé.`
                  : `Aucun${isPassword ? "" : "e"} ${noun.replace(/^l[ae] /, "")} enregistré${isPassword ? "" : "e"} pour cet hôte.`}
              </p>
            )}
            {storedSecrets.state === "unavailable" && (
              <p className="help-text mt-1 text-[var(--c-warn)]" title={storedSecrets.reason}>
                Coffre illisible : laissé vide, {noun} enregistré{isPassword ? "" : "e"} est conservé{isPassword ? "" : "e"}.
              </p>
            )}
          </Field>
        );
      })()}
    </div>
  );

  const renderReseau = () => (
    <div className="space-y-4">
      <FieldGroup label="Chaîne de bastions">
        <div className="card space-y-1 p-2">
          {jumpVia.length === 0 && <p className="px-1 py-0.5 text-[12px] text-[var(--c-text-muted)]">Connexion directe (aucun bastion)</p>}
          {jumpVia.map((id, i) => {
            const h = workspace.hosts.find((host) => host.id === id);
            return (
              <div key={id} className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--c-bg2)] px-2">
                <span className="w-4 shrink-0 text-center font-mono text-[10.5px] text-[var(--c-text-muted)]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{h?.label ?? id}</span>
                <span className="hidden truncate font-mono text-[11px] text-[var(--c-text-muted)] sm:inline">{h ? `${h.username}@${h.address}` : ""}</span>
                <button type="button" onClick={() => moveUp(i)} disabled={i === 0} aria-label="Monter" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↑</button>
                <button type="button" onClick={() => moveDown(i)} disabled={i === jumpVia.length - 1} aria-label="Descendre" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↓</button>
                <button type="button" onClick={() => removeJump(i)} aria-label="Retirer" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
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
              className="input mt-1 flex w-full items-center justify-between gap-2 text-left"
            />
          )}
        </div>
      </FieldGroup>

      <FieldGroup label="Commande de proxy">
        <div className="space-y-1.5">
          <textarea
            value={proxyCommand}
            onChange={(e) => setProxyCommandChecked(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder="Connexion directe (aucune commande de proxy)"
            className="input input-mono w-full resize-y"
          />
          <p className="help-text" title="Le programme relaie SSH sur son entrée/sortie standard au lieu d'une connexion directe à l'adresse : c'est ainsi qu'on atteint une machine sans IP publique ni SSH entrant.">
            Pour une machine sans IP publique. <code className="text-[var(--c-text-secondary)]">%h</code> adresse,{" "}
            <code className="text-[var(--c-text-secondary)]">%p</code> port,{" "}
            <code className="text-[var(--c-text-secondary)]">%r</code> utilisateur.
          </p>
          {proxyCommand.trim() && jumpVia.length > 0 && (
            <p className="callout callout-warn">
              Incompatible avec la chaîne de bastions ci-dessus : les deux remplacent le transport.
            </p>
          )}
          {proxyCommand.trim() && (
            <button
              type="button"
              onClick={runProxyProbe}
              disabled={proxyProbing || !address.trim()}
              className="btn btn-secondary btn-sm"
            >
              {proxyProbing ? "Test en cours…" : "Tester la commande"}
            </button>
          )}
          {proxyProbe && <ProxyProbeResult probe={proxyProbe} />}
          <details className="card px-2 py-1.5">
            <summary className="cursor-pointer select-none text-[12px] text-[var(--c-text-secondary)] hover:text-[var(--c-text)]">
              Exemples — cliquer pour insérer
            </summary>
            <div className="mt-1.5 space-y-1">
              {PROXY_COMMAND_EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => setProxyCommandChecked(example.command)}
                  title={example.command}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--c-hover)]"
                >
                  <span className="text-[12px] font-medium text-[var(--c-text)]">{example.label}</span>
                  <span className="ml-1.5 text-[11px] text-[var(--c-text-muted)]">{example.hint}</span>
                  <code className="mt-0.5 block truncate font-mono text-[11px] text-[var(--c-text-secondary)]">
                    {example.command}
                  </code>
                </button>
              ))}
            </div>
          </details>
        </div>
      </FieldGroup>

      <Field label="Keepalive (secondes, 0 = désactivé)">
        <input value={keepalive} onChange={(e) => setKeepalive(e.target.value)} inputMode="numeric" className="input input-mono w-[120px]" />
      </Field>
    </div>
  );

  const renderSession = () => (
    <div className="space-y-4">
      {sshOnlyExtras && (
        <Field label="Session persistante">
          <select
            value={persistentShell}
            onChange={(e) => setPersistentShell(e.target.value as PersistentShellMode)}
            className="input"
          >
            <option value="off">Désactivée — un shell neuf à chaque connexion</option>
            <option value="tmux">tmux — reprendre le terminal là où il en était</option>
          </select>
          <p
            className="help-text mt-1.5"
            title={persistentShell === "tmux"
              ? "Le terminal tourne dans une session tmux nommée, côté serveur : coupure réseau, fermeture de l'app ou redémarrage retrouvent l'écran laissé. Sans tmux sur l'hôte, la connexion s'ouvre normalement et le terminal le signale."
              : "Une connexion perdue est rétablie sur un shell vierge : dossier courant, commande en cours et écran sont perdus."}
          >
            {persistentShell === "tmux"
              ? "Une coupure retrouve l'écran laissé, commandes en cours comprises."
              : "Une reconnexion repart d'un shell vierge."}
          </p>
        </Field>
      )}

      <FieldGroup label="Snippets au démarrage">
        <div className="card space-y-1 p-2">
          {startupSnippets.length === 0 && <p className="px-1 py-0.5 text-[12px] text-[var(--c-text-muted)]">Aucun snippet au démarrage</p>}
          {startupSnippets.map((id, i) => {
            const s = workspace.snippets.find((sn) => sn.id === id);
            return (
              <div key={id} className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--c-bg2)] px-2">
                <span className="w-4 shrink-0 text-center font-mono text-[10.5px] text-[var(--c-text-muted)]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">{s?.name ?? id}</span>
                <button type="button" onClick={() => moveSnippetUp(i)} disabled={i === 0} aria-label="Monter" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↑</button>
                <button type="button" onClick={() => moveSnippetDown(i)} disabled={i === startupSnippets.length - 1} aria-label="Descendre" className="btn btn-ghost btn-sm btn-icon disabled:opacity-20">↓</button>
                <button type="button" onClick={() => removeStartupSnippet(i)} aria-label="Retirer" className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            );
          })}
          {snippetChoices.length > 0 && (
            <select value="" onChange={(e) => addStartupSnippet(e.target.value)} className="input mt-1 w-full">
              <option value="" disabled>+ Ajouter un snippet…</option>
              {snippetChoices.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
        </div>
      </FieldGroup>

      <FieldGroup label="Variables d'environnement">
        <div className="card space-y-1.5 p-2">
          {envVars.length === 0 && <p className="px-1 py-0.5 text-[12px] text-[var(--c-text-muted)]">Aucune variable définie</p>}
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
                  className="input input-mono w-36 shrink-0"
                />
                <input
                  value={v.value}
                  onChange={(e) => setEnvValue(i, e.target.value)}
                  type={v.secret ? "password" : "text"}
                  placeholder={storedSecret ? "enregistrée — laisser vide pour conserver" : "valeur"}
                  className="input input-mono min-w-0 flex-1"
                />
                <button
                  type="button"
                  onClick={() => setEnvSecret(i, !v.secret)}
                  title={v.secret
                    ? "Valeur gardée dans le coffre (trousseau OS ou coffre chiffré) — cliquer pour la remettre en clair dans workspace.json"
                    : "Garder cette valeur dans le coffre plutôt qu'en clair dans workspace.json"}
                  aria-pressed={v.secret}
                  className={`btn btn-icon ${v.secret ? "btn-toggled" : "btn-ghost text-[var(--c-text-muted)]"}`}
                >
                  {v.secret ? <IconLock size={13} /> : <IconUnlock size={13} />}
                </button>
                <button type="button" onClick={() => removeEnvVar(i)} aria-label="Retirer" className="btn btn-ghost btn-icon hover:text-[var(--c-danger)]"><IconClose size={11} /></button>
              </div>
            );
          })}
          <p className="help-text px-1 pt-0.5">
            Le cadenas met la valeur au coffre au lieu de <span className="font-mono">workspace.json</span>.
          </p>
          <button type="button" onClick={addEnvVar} className="btn btn-ghost btn-sm w-full text-[var(--c-text-muted)]">
            <IconPlus size={11} /> Ajouter une variable
          </button>
        </div>
      </FieldGroup>
    </div>
  );

  const renderOrganisation = () => (
    <div className="space-y-4">
      <Field label="Dossier">
        <GroupTreePicker
          groups={workspace.groups}
          value={groupId || null}
          onChange={(id) => setGroupId(id ?? "")}
          customIcons={workspace.customIcons}
        />
      </Field>

      <VaultField vaults={vaults} value={vaultId} onChange={setVaultId} readOnly={vaultReadOnly} hint="Sa clé du trousseau et son icône le suivent ; son dossier aussi." />

      <FieldGroup label="Étiquettes">
        <div className="input flex h-auto min-h-7 flex-wrap items-center gap-1.5 py-1">
          {tags.map((tag) => (
            <span key={tag} className="tag tag-accent gap-1 pr-1">
              {tag}
              <button type="button" onClick={() => setTags(tags.filter((t) => t !== tag))} aria-label={`Retirer ${tag}`} className="rounded-sm opacity-70 hover:opacity-100">
                <IconClose size={9} />
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
            className="min-w-[8rem] flex-1 bg-transparent text-[12.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)]"
          />
        </div>
      </FieldGroup>
    </div>
  );

  const renderSection = () => {
    switch (activeSection) {
      case "connexion": return renderConnexion();
      case "auth": return renderAuth();
      case "reseau": return renderReseau();
      case "session": return renderSession();
      case "organisation": return renderOrganisation();
      default: return assertNever(activeSection, "section du formulaire d'hôte");
    }
  };

  const footer = (
    <>
      {host && onDeleteHost && !vaultReadOnly && (
        <DrawerDeleteButton
          what="cet hôte"
          confirming={confirmDelete}
          onAsk={() => setConfirmDelete(true)}
          onConfirm={() => onDeleteHost(host.id)}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      <span className="flex-1" />
      {kind === "ssh" && (
        <button type="button" onClick={runTest} disabled={testing} className="btn btn-secondary">
          <IconPlay size={12} /> {testing ? "Test en cours…" : "Tester la connexion"}
        </button>
      )}
      <button type="button" onClick={onCancel} className="btn btn-ghost">Annuler</button>
      <DrawerSaveButton onClick={submit} disabled={vaultReadOnly} />
    </>
  );

  return (
    <FormDrawer
      title={host ? host.label : "Nouvel hôte"}
      subtitle={subtitle}
      icon={icon ? <HostIcon iconId={icon} customIcons={workspace.customIcons} size={18} /> : <kindMeta.Icon size={16} />}
      sections={visibleSections.map((id) => SECTIONS[id])}
      active={activeSection}
      onSection={setSection}
      onCancel={onCancel}
      onSubmit={submit}
      submitDisabled={vaultReadOnly}
      footer={footer}
    >
      {/* `fieldset disabled` : tout le formulaire est grisé d'un coup pour
          une entité d'un vault lu — `display: contents` le rend invisible
          à la mise en page. */}
      <fieldset disabled={vaultReadOnly} className="contents min-w-0">
        <div data-host-form-section={activeSection} className="space-y-4">
          {currentVault && <ReadOnlyVaultNotice vault={currentVault} what="cet hôte" />}
          {error && <p className="callout callout-danger">{error}</p>}
          {renderSection()}

          {kind === "ssh" && (commandLine || test) && (
            <div className="space-y-2 border-t border-[var(--c-border)] pt-4">
              {commandLine && (
                <div data-ssh-command className="card space-y-1.5 bg-[var(--c-bg3)] px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[11.5px] text-[var(--c-text-muted)]">Équivalent en ligne de commande</span>
                    <button type="button" onClick={copyCommand} aria-label="Copier la commande" title={copied ? "Copiée" : "Copier la commande"} className="btn btn-ghost btn-sm btn-icon">
                      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    </button>
                  </div>
                  <code className="block break-all font-mono text-[12px] text-[var(--c-text-secondary)]">{commandLine}</code>
                </div>
              )}
              {test && <ConnectionTestResult result={test.result} stale={test.signature !== signature} onOpenSection={setSection} />}
            </div>
          )}
        </div>
      </fieldset>
    </FormDrawer>
  );
}
