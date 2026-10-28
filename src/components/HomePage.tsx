import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { describeAlert } from "../lib/awsIdentities";
import { formatRelativeTime } from "../lib/format";
import type { ImportSource } from "../lib/importSources";
import { parseSSHInput, quickSshCommand } from "../lib/quickConnect";
import { sameTarget, type RecentEntry, type RecentTarget } from "../lib/recents";
import type { SnippetUse } from "../lib/snippetUsage";
import { sqlConnectionViaHostId, type AwsSessionAlert, type GuiVaultStatus, type Host, type PortForward, type PortForwardId, type Snippet, type SqlConnection, type VaultId, type Workspace } from "../lib/types";
import { hasIcon, HostIcon } from "./icons";
import {
  IconCloud, IconDatabase, IconDocker, IconDownload, IconKubernetes, IconMonitor, IconPin, IconPlus, IconSearch,
  IconPlay, IconSnippets, IconTerminal, IconTunnels, IconVault, IconWarning,
} from "./ui-icons";

export interface HomePageProps {
  workspace: Workspace;
  recents: RecentEntry[];
  /** Ce qui est ouvert en ce moment, pour marquer « Ouvert » sur un récent. */
  openTargets: RecentTarget[];
  /** Les sessions tmux déjà affichées dans un onglet : rien à reprendre. */
  openSessionKeys: Set<string>;
  openTabCount: number;
  guivaultStatus: GuiVaultStatus | null;
  awsAlerts: AwsSessionAlert[];
  paletteCombo?: string;
  onOpenRecent: (entry: RecentEntry) => void;
  onResumeSession: (entry: RecentEntry) => void;
  onForgetSession: (sessionKey: string) => void;
  onOpenHost: (host: Host) => void;
  onQuickSSH: (command: string) => void;
  onNewHost: () => void;
  /** Ouvre « Importer des hôtes » sur cette source. */
  onImport: (source: ImportSource) => void;
  /** Les snippets les plus lancés ces derniers temps (`lib/snippetUsage.ts`). */
  frequentSnippets: { snippet: Snippet; use: SnippetUse }[];
  /** Le terminal où un snippet de l'accueil s'exécuterait : l'onglet actif,
   * resté dessous. `null` sans terminal. */
  snippetTarget: string | null;
  onRunSnippet: (snippet: Snippet) => void;
  onShowSnippets: () => void;
  onOpenGuiVault: (vaultId: VaultId | null) => void;
  onOpenAwsIdentities: () => void;
  onShowTunnels: () => void;
  onLocalTerminal: () => void;
}

/** « il y a 5 min », « il y a 3 j », puis « 14 oct. » : en français quelle
 * que soit la langue du système, comme le reste de l'interface. */
function when(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return formatRelativeTime(ts);
  if (days < 7) return `il y a ${days} j`;
  return new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Combien de récents l'accueil montre ; la liste en retient plus. */
const VISIBLE_RECENTS = 8;

function kindIcon(host: Host, size = 14): ReactNode {
  switch (host.kind ?? "ssh") {
    case "dockerExec": return <IconDocker size={size} />;
    case "k8sExec": return <IconKubernetes size={size} />;
    case "rdp": return <IconMonitor size={size} />;
    default: return <IconTerminal size={size} />;
  }
}

function hostTarget(host: Host): string {
  return `${host.username ? `${host.username}@` : ""}${host.address}`;
}

/** Ce qu'une ligne de récents affiche. `null` quand la cible a disparu entre
 * deux rendus (le nettoyage des récents suit la suppression). */
function describeRecent(entry: RecentEntry, workspace: Workspace): { title: string; detail: string; icon: ReactNode } | null {
  if (entry.kind === "database") {
    const conn: SqlConnection | undefined = workspace.sqlConnections.find((c) => c.id === entry.connectionId);
    if (!conn) return null;
    const viaId = sqlConnectionViaHostId(conn);
    const via = viaId ? workspace.hosts.find((h) => h.id === viaId)?.label : undefined;
    return { title: conn.label, detail: [conn.engine, via ? `via ${via}` : null].filter(Boolean).join(" · "), icon: <IconDatabase size={14} /> };
  }
  const host = workspace.hosts.find((h) => h.id === entry.hostId);
  if (!host) return null;
  const icon = hasIcon(host.icon, workspace.customIcons) ? <HostIcon iconId={host.icon} customIcons={workspace.customIcons} size={14} /> : kindIcon(host);
  if (entry.kind === "rdp") return { title: host.label, detail: `${hostTarget(host)} · bureau à distance`, icon };
  const inside = entry.k8sPodName ? `pod ${entry.k8sPodName}` : entry.dockerContainerId ? `conteneur ${entry.dockerContainerId.slice(0, 12)}` : null;
  return { title: host.label, detail: [hostTarget(host), inside].filter(Boolean).join(" · "), icon };
}

/**
 * La page d'accueil : ce qu'on ouvre en arrivant, et ce qu'on retrouve en
 * cliquant le logo. Un point de départ plutôt qu'un écran vide — se
 * connecter, rouvrir, reprendre une session, voir ce qui tourne et ce qui
 * demande une action.
 *
 * Sans hôte ni dossier, elle devient l'écran de premier lancement : les trois
 * façons de commencer (importer `~/.ssh/config`, créer un hôte, retrouver un
 * compte GuiVault), avec le nombre d'hôtes que l'import trouverait.
 */
export function HomePage(props: HomePageProps) {
  const { workspace, recents, guivaultStatus, awsAlerts, paletteCombo } = props;
  const firstLaunch = workspace.hosts.length === 0 && workspace.groups.length === 0;

  return (
    <div data-home-page={firstLaunch ? "first-launch" : "home"} className="absolute inset-0 z-10 overflow-y-auto bg-[var(--c-bg)]">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-6 py-8">
        {firstLaunch ? <Welcome {...props} /> : <Overview {...props} recents={recents} guivaultStatus={guivaultStatus} awsAlerts={awsAlerts} />}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-2 text-[11.5px] text-[var(--c-text-muted)]">
          <span className="flex items-center gap-1.5"><span className="kbd">Ctrl</span><span className="kbd">T</span> terminal local</span>
          {paletteCombo && <span className="flex items-center gap-1.5">{paletteCombo.split("+").map((k) => <span key={k} className="kbd">{k}</span>)} tout chercher</span>}
          <span className="flex items-center gap-1.5"><span className="kbd">Ctrl</span><span className="kbd">B</span> panneau</span>
        </div>
      </div>
    </div>
  );
}

/** Connexion rapide : un hôte enregistré (recherche par nom, adresse ou tag)
 * ou une adresse `user@hôte[:port]` tapée telle quelle. */
function QuickConnect({ workspace, onOpenHost, onQuickSSH, autoFocus }: Pick<HomePageProps, "workspace" | "onOpenHost" | "onQuickSSH"> & { autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const direct = parseSSHInput(query);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || direct) return [];
    return workspace.hosts
      .filter((h) => [h.label, h.address, h.username, ...h.tags].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 6);
  }, [query, direct, workspace.hosts]);
  useEffect(() => { setCursor(0); }, [query]);

  const submit = () => {
    if (direct) { onQuickSSH(quickSshCommand(direct)); setQuery(""); return; }
    const host = matches[cursor];
    if (host) { onOpenHost(host); setQuery(""); }
  };

  return (
    <div className="relative" data-quick-connect="">
      <div className="flex items-center gap-2">
        <div className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-[var(--c-border)] bg-[var(--c-bg2)] px-3 focus-within:border-[var(--c-accent)]">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(matches.length - 1, 0))); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); submit(); }
              else if (e.key === "Escape") setQuery("");
            }}
            placeholder="Un hôte, ou user@adresse:port"
            aria-label="Connexion rapide"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono outline-none text-[13px] text-[var(--c-text)] placeholder:font-sans placeholder:text-[var(--c-text-faint)]"
          />
        </div>
        <button type="button" onClick={submit} disabled={!direct && matches.length === 0} className="btn btn-primary h-10 px-4">
          Se connecter
        </button>
      </div>
      {(direct || matches.length > 0) && (
        <div className="popover absolute left-0 right-[112px] top-[46px] z-20 p-1">
          {direct ? (
            <button type="button" onClick={submit} className="menu-item w-full">
              <IconTerminal size={13} />
              <span className="flex-1 truncate text-left">Ouvrir <span className="font-mono">{quickSshCommand(direct)}</span> dans un terminal local</span>
              <span className="kbd">Entrée</span>
            </button>
          ) : matches.map((h, i) => (
            <button
              key={h.id}
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => { onOpenHost(h); setQuery(""); }}
              className={`menu-item w-full ${i === cursor ? "bg-[var(--c-hover)]" : ""}`}
            >
              {kindIcon(h, 13)}
              <span className="truncate font-medium">{h.label}</span>
              <span className="flex-1 truncate text-left font-mono text-[11.5px] text-[var(--c-text-muted)]">{hostTarget(h)}</span>
              {i === cursor && <span className="kbd">Entrée</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="eyebrow">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Overview(props: HomePageProps) {
  const { workspace, recents, openTargets, openSessionKeys, openTabCount, guivaultStatus, awsAlerts } = props;
  const [running, setRunning] = useState<Set<PortForwardId>>(new Set());

  // Interrogé à l'arrivée sur l'accueil, puis toutes les cinq secondes tant
  // qu'il est affiché : un tunnel se lance et s'arrête depuis son panneau, et
  // aucun événement ne le signale.
  useEffect(() => {
    let cancelled = false;
    const load = () => api.runningForwards().then((ids) => { if (!cancelled) setRunning(new Set(ids)); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const rows = recents
    .map((entry) => ({ entry, view: describeRecent(entry, workspace) }))
    .filter((r): r is { entry: RecentEntry; view: NonNullable<ReturnType<typeof describeRecent>> } => r.view !== null);
  const toResume = rows.filter(({ entry }) => entry.sessionKey && !openSessionKeys.has(entry.sessionKey)).slice(0, 4);
  const tunnels: PortForward[] = workspace.portForwards.filter((f) => running.has(f.id));
  const rollbacks = guivaultStatus?.rollbacks ?? [];
  const hostLabel = (id: string) => workspace.hosts.find((h) => h.id === id)?.label ?? "hôte inconnu";

  const summary = [
    `${workspace.hosts.length} hôte${workspace.hosts.length > 1 ? "s" : ""}`,
    openTabCount > 0 ? `${openTabCount} onglet${openTabCount > 1 ? "s" : ""} ouvert${openTabCount > 1 ? "s" : ""}` : null,
    guivaultStatus?.configured && guivaultStatus.lastSyncAt ? `synchronisé ${formatRelativeTime(Date.parse(guivaultStatus.lastSyncAt))}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <header className="flex items-baseline gap-3 px-1">
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--c-text)]">Accueil</h1>
        <p className="text-[12.5px] text-[var(--c-text-muted)]">{summary}</p>
      </header>

      <QuickConnect workspace={workspace} onOpenHost={props.onOpenHost} onQuickSSH={props.onQuickSSH} autoFocus={openTabCount === 0} />

      {(rollbacks.length > 0 || awsAlerts.length > 0) && (
        <div className="flex flex-col gap-2" data-home-alerts="">
          {rollbacks.map((r) => (
            <div key={r.vaultId} className="callout callout-warn flex items-center gap-3">
              <IconWarning size={14} />
              <p className="flex-1 text-[12.5px]"><strong>{r.name}</strong> est revenu en arrière : synchro suspendue pour ce vault.</p>
              <button type="button" onClick={() => props.onOpenGuiVault(r.vaultId)} className="btn btn-secondary btn-sm">Examiner</button>
            </div>
          ))}
          {awsAlerts.map((a) => (
            <div key={a.session} className="callout callout-warn flex items-center gap-3">
              <IconCloud size={14} />
              <p className="flex-1 text-[12.5px]">{describeAlert(a)}</p>
              <button type="button" onClick={props.onOpenAwsIdentities} className="btn btn-secondary btn-sm">Renouveler</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Section title="Récents">
          {rows.length === 0 ? (
            <p className="card px-4 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">
              Vos dernières connexions apparaîtront ici.
            </p>
          ) : (
            <div className="card flex flex-col p-1" data-home-recents="">
              {rows.slice(0, VISIBLE_RECENTS).map(({ entry, view }) => {
                const open = openTargets.some((t) => sameTarget(t, entry));
                return (
                  <button
                    key={`${entry.kind}:${entry.kind === "database" ? entry.connectionId : entry.hostId}:${entry.kind === "terminal" ? entry.dockerContainerId ?? entry.k8sPodName ?? "" : ""}`}
                    type="button"
                    onClick={() => props.onOpenRecent(entry)}
                    className="list-row flex items-center gap-3 rounded-md px-3 py-2 text-left"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--c-border)] text-[var(--c-text-muted)]">{view.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--c-text)]">{view.title}</span>
                      <span className="block truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{view.detail}</span>
                    </span>
                    {open ? <span className="tag">Ouvert</span> : entry.sessionKey ? <span className="tag">tmux</span> : null}
                    <span className="shrink-0 text-[11.5px] text-[var(--c-text-faint)]">{when(entry.at)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        <div className="flex flex-col gap-6">
          {toResume.length > 0 && (
            <Section title="Sessions à reprendre">
              <div className="card flex flex-col p-1" data-home-sessions="">
                {toResume.map(({ entry, view }) => (
                  <div key={entry.sessionKey} className="group flex items-center gap-3 rounded-md px-3 py-2">
                    <span className="text-[var(--c-text-muted)]"><IconPin size={13} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--c-text)]">{view.title}</span>
                      <span className="block truncate text-[11.5px] text-[var(--c-text-muted)]">Détachée · {when(entry.at)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => props.onForgetSession(entry.sessionKey!)}
                      title="Ne plus proposer cette session (elle continue de tourner sur l'hôte)"
                      className="btn btn-ghost btn-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      Masquer
                    </button>
                    <button type="button" onClick={() => props.onResumeSession(entry)} className="btn btn-secondary btn-sm">Reprendre</button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section
            title="Tunnels actifs"
            action={<button type="button" onClick={props.onShowTunnels} className="btn btn-ghost btn-sm text-[var(--c-text-muted)]">Tous</button>}
          >
            {tunnels.length === 0 ? (
              <p className="card px-4 py-4 text-[12.5px] text-[var(--c-text-muted)]">Aucun tunnel en cours.</p>
            ) : (
              <div className="card flex flex-col p-1" data-home-tunnels="">
                {tunnels.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 rounded-md px-3 py-2">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--c-ok)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] text-[var(--c-text)]">
                        {f.kind === "dynamic" ? `SOCKS :${f.bindPort}` : `${f.bindAddress}:${f.bindPort} → ${f.destAddress}:${f.destPort}`}
                      </span>
                      <span className="block truncate text-[11.5px] text-[var(--c-text-muted)]">
                        {f.kind === "local" ? "Tunnel local" : f.kind === "remote" ? "Tunnel distant" : "Tunnel dynamique"} via {hostLabel(f.hostId)}
                      </span>
                    </span>
                    <IconTunnels size={13} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {props.frequentSnippets.length > 0 && <FrequentSnippets {...props} />}
        </div>
      </div>
    </>
  );
}

/** Les snippets qu'on lance le plus, à relancer d'un clic dans le terminal
 * resté sous l'accueil. Sans terminal ouvert, la ligne dit où ça irait
 * plutôt que d'échouer au clic. */
function FrequentSnippets({ frequentSnippets, snippetTarget, onRunSnippet, onShowSnippets }: HomePageProps) {
  return (
    <Section
      title="Snippets fréquents"
      action={<button type="button" onClick={onShowSnippets} className="btn btn-ghost btn-sm text-[var(--c-text-muted)]">Tous</button>}
    >
      <div className="card flex flex-col p-1" data-home-snippets="">
        {frequentSnippets.map(({ snippet, use }) => (
          <button
            key={snippet.id}
            type="button"
            disabled={!snippetTarget}
            onClick={() => onRunSnippet(snippet)}
            title={snippetTarget ? `Exécuter dans « ${snippetTarget} » · lancé ${use.count} fois` : "Ouvrez un terminal pour lancer un snippet"}
            className="list-row group flex items-center gap-3 rounded-md px-3 py-2 text-left disabled:cursor-default"
          >
            <span className="text-[var(--c-text-muted)]"><IconSnippets size={13} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-[var(--c-text)]">{snippet.name}</span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{snippet.command.split("\n")[0]}</span>
            </span>
            {snippet.adaptive && <span className="chip chip-accent">Adaptatif</span>}
            {snippetTarget && <span className="text-[var(--c-text-faint)] opacity-0 group-hover:opacity-100"><IconPlay size={11} /></span>}
          </button>
        ))}
      </div>
      {!snippetTarget && <p className="px-1 text-[11.5px] text-[var(--c-text-faint)]">Ouvrez un terminal pour les lancer d'ici.</p>}
    </Section>
  );
}

function Welcome(props: HomePageProps) {
  const [found, setFound] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.previewSshConfigImport(null).then((hosts) => { if (!cancelled) setFound(hosts.length); }).catch(() => { if (!cancelled) setFound(0); });
    return () => { cancelled = true; };
  }, []);

  const signedIn = props.guivaultStatus?.configured ?? false;
  const choices: { key: string; icon: ReactNode; title: string; text: string; badge?: string; action: string; primary?: boolean; run: () => void }[] = [
    {
      key: "ssh-config",
      icon: <IconDownload size={16} />,
      title: "Importer ~/.ssh/config",
      text: "Vos alias, utilisateurs, ports et bastions, tels quels.",
      badge: found === null ? undefined : found === 0 ? "Aucun hôte trouvé" : `${found} hôte${found > 1 ? "s" : ""} trouvé${found > 1 ? "s" : ""}`,
      action: "Prévisualiser",
      primary: (found ?? 0) > 0,
      run: () => props.onImport("sshConfig"),
    },
    {
      key: "new-host",
      icon: <IconPlus size={16} />,
      title: "Ajouter un hôte",
      text: "SSH, conteneur Docker, pod Kubernetes ou bureau à distance.",
      action: "Nouvel hôte",
      primary: found === 0,
      run: props.onNewHost,
    },
    {
      key: "guivault",
      icon: <IconVault size={16} />,
      title: signedIn ? "Mon compte GuiVault" : "J'ai un compte GuiVault",
      text: "Retrouver hôtes, clés et snippets, chiffrés de bout en bout.",
      action: signedIn ? "Ouvrir" : "Se connecter",
      run: () => props.onOpenGuiVault(null),
    },
  ];

  return (
    <>
      <header className="flex flex-col items-center gap-1.5 pt-6 text-center">
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--c-text)]">Bienvenue dans Guiterm</h1>
        <p className="text-[13px] text-[var(--c-text-muted)]">Ajoutez vos serveurs, ou connectez-vous tout de suite.</p>
      </header>

      <QuickConnect workspace={props.workspace} onOpenHost={props.onOpenHost} onQuickSSH={props.onQuickSSH} autoFocus />

      <div className="grid grid-cols-1 gap-3 min-[820px]:grid-cols-3" data-home-welcome="">
        {choices.map((c) => (
          <div key={c.key} data-welcome-choice={c.key} className="card flex flex-col gap-3 p-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]">{c.icon}</span>
            <div className="flex-1">
              <p className="text-[13.5px] font-semibold text-[var(--c-text)]">{c.title}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--c-text-muted)]">{c.text}</p>
            </div>
            {c.badge && <span className="tag self-start">{c.badge}</span>}
            <button type="button" onClick={c.run} className={`btn ${c.primary ? "btn-primary" : "btn-secondary"} self-start`}>{c.action}</button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-[12px] text-[var(--c-text-muted)]">Importer aussi depuis</span>
        {([["aws", "AWS"], ["azure", "Azure"], ["gcp", "Google Cloud"], ["ansible", "Inventaire Ansible"], ["file", "Un fichier d'export"]] as const).map(([source, label]) => (
          <button key={source} type="button" data-import-chip={source} onClick={() => props.onImport(source)} className="chip">{label}</button>
        ))}
      </div>

      <div className="flex justify-center">
        <button type="button" onClick={props.onLocalTerminal} className="btn btn-ghost text-[var(--c-text-muted)]">
          <IconTerminal size={13} /> Ouvrir un terminal local
        </button>
      </div>
    </>
  );
}
