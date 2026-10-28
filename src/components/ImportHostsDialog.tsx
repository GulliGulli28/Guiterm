import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { api } from "../lib/api";
import { assertNever } from "../lib/exhaustive";
import { awsStatus, cloudCliStatus, IMPORT_SOURCES, sshConfigStatus, type ImportSource, type SourceStatus } from "../lib/importSources";
import type { AwsSsoSession, CloudCliError, CloudFailure, SshConfigHost, Workspace } from "../lib/types";
import { AnsibleImportPanel } from "./AnsibleImportPanel";
import { AwsImportPanel } from "./AwsImportPanel";
import { AzureImportPanel } from "./AzureImportPanel";
import { FileImportSource } from "./FileImportSource";
import { GcpImportPanel } from "./GcpImportPanel";
import { alreadyImported, SshConfigImportSource } from "./SshConfigImportSource";
import { IconChecklist, IconClose, IconCloud, IconDownload, IconFile } from "./ui-icons";

type CloudProbe = { scopes: number } | { reason: CloudCliError | null } | null;

function probeCli(list: () => Promise<unknown[]>, set: (p: CloudProbe) => void): () => void {
  let cancelled = false;
  list()
    .then((found) => { if (!cancelled) set({ scopes: found.length }); })
    .catch((e) => {
      if (cancelled) return;
      const failure = e as Partial<CloudFailure> | null;
      set({ reason: failure && typeof failure === "object" && failure.reason ? failure.reason : null });
    });
  return () => { cancelled = true; };
}

function sourceIcon(source: ImportSource): ReactNode {
  switch (source) {
    case "sshConfig": return <IconFile size={15} />;
    case "aws":
    case "gcp":
    case "azure": return <IconCloud size={15} />;
    case "ansible": return <IconChecklist size={15} />;
    case "file": return <IconDownload size={15} />;
    default: return assertNever(source, "sourceIcon");
  }
}

/**
 * « Importer des hôtes » : une fenêtre, six sources, un aperçu avant tout
 * enregistrement (tranche 3c de `docs/refonte-ui.md`).
 *
 * Elle remplace six entrées dispersées : l'import de `~/.ssh/config` caché
 * dans Known Hosts, le sélecteur de fournisseur cloud puis le panneau de
 * chacun, le panneau Ansible, l'import d'un hôte depuis un fichier qui ne
 * montrait rien. Chaque source garde son propre composant (ses champs, son
 * vocabulaire) ; la fenêtre porte le titre, la fermeture, et la colonne de
 * gauche qui dit d'avance où chaque source en est — combien d'hôtes dans
 * `~/.ssh/config`, si `gcloud` est connecté, si `az` est installé.
 *
 * Les sondages des CLI cloud partent à l'ouverture, en parallèle : `gcloud`
 * met parfois quelques secondes, et sa ligne d'état dit « Recherche… »
 * pendant ce temps plutôt que de retarder la fenêtre.
 */
export function ImportHostsDialog({
  workspace,
  initialSource,
  awsProfilesEpoch,
  onWorkspaceUpdate,
  onError,
  onClose,
  onConfigureSso,
  onReconnectSso,
}: {
  workspace: Workspace;
  initialSource: ImportSource;
  /** Change quand le panneau SSO a créé des profils : AWS les relit. */
  awsProfilesEpoch: number;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
  onClose: () => void;
  onConfigureSso: () => void;
  onReconnectSso: (session: AwsSsoSession) => void;
}) {
  const [source, setSource] = useState<ImportSource>(initialSource);
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Importer des hôtes" });

  const [sshConfig, setSshConfig] = useState<SshConfigHost[] | null>(null);
  const [awsProfiles, setAwsProfiles] = useState<number | null>(null);
  const [gcp, setGcp] = useState<CloudProbe>(null);
  const [azure, setAzure] = useState<CloudProbe>(null);

  useEffect(() => {
    let cancelled = false;
    api.previewSshConfigImport(null)
      .then((found) => { if (!cancelled) setSshConfig(found); })
      .catch((e) => { if (!cancelled) { onError(String(e)); setSshConfig([]); } });
    return () => { cancelled = true; };
    // Lu une fois à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.listAwsProfiles()
      .then((found) => { if (!cancelled) setAwsProfiles(found.length); })
      .catch(() => { if (!cancelled) setAwsProfiles(0); });
    return () => { cancelled = true; };
  }, [awsProfilesEpoch]);
  useEffect(() => probeCli(api.listGcpProjects, setGcp), []);
  useEffect(() => probeCli(api.listAzureSubscriptions, setAzure), []);

  const sshPresent = useMemo(
    () => (sshConfig ?? []).filter((h) => alreadyImported(h, workspace.hosts)).length,
    [sshConfig, workspace.hosts],
  );

  const status = (id: ImportSource): SourceStatus => {
    switch (id) {
      case "sshConfig": return sshConfigStatus(sshConfig?.length ?? null, sshPresent);
      case "aws": return awsStatus(awsProfiles);
      case "gcp": return cloudCliStatus("gcloud", gcp, ["projet", "projets"]);
      case "azure": return cloudCliStatus("az", azure, ["abonnement", "abonnements"]);
      case "ansible": return { tone: "muted", text: "Choisir un fichier" };
      case "file": return { tone: "muted", text: ".json" };
      default: return assertNever(id, "ImportHostsDialog.status");
    }
  };

  const body = (): ReactNode => {
    switch (source) {
      case "sshConfig":
        return <SshConfigImportSource workspace={workspace} found={sshConfig} onWorkspaceUpdate={onWorkspaceUpdate} onError={onError} onClose={onClose} />;
      case "aws":
        return (
          <AwsImportPanel
            key={`aws-${awsProfilesEpoch}`}
            workspace={workspace}
            onWorkspaceUpdate={onWorkspaceUpdate}
            onClose={onClose}
            onError={onError}
            onConfigureSso={onConfigureSso}
            onReconnectSso={onReconnectSso}
          />
        );
      case "gcp":
        return <GcpImportPanel workspace={workspace} onWorkspaceUpdate={onWorkspaceUpdate} onClose={onClose} onError={onError} />;
      case "azure":
        return <AzureImportPanel workspace={workspace} onWorkspaceUpdate={onWorkspaceUpdate} onClose={onClose} onError={onError} />;
      case "ansible":
        return <AnsibleImportPanel workspace={workspace} onWorkspaceUpdate={onWorkspaceUpdate} onClose={onClose} onError={onError} />;
      case "file":
        return <FileImportSource onWorkspaceUpdate={onWorkspaceUpdate} onError={onError} onClose={onClose} />;
      default:
        return assertNever(source, "ImportHostsDialog.body");
    }
  };

  const toneClass: Record<SourceStatus["tone"], string> = {
    ok: "text-[var(--c-ok)]",
    warn: "text-[var(--c-warn)]",
    muted: "text-[var(--c-text-muted)]",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        ref={ref}
        {...dialogProps}
        data-import-hosts=""
        onClick={(e) => e.stopPropagation()}
        className="modal flex h-[min(640px,100%)] w-[min(980px,100%)] flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--c-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-[var(--c-text)]">Importer des hôtes</p>
            <p className="text-[12px] text-[var(--c-text-muted)]">Rien n'est enregistré avant que vous confirmiez.</p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="btn btn-ghost btn-sm btn-icon">
            <IconClose size={13} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div role="radiogroup" aria-label="Source" className="flex w-[250px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--c-border)] p-2">
            {IMPORT_SOURCES.map(({ id, label }) => {
              const s = status(id);
              const active = id === source;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-import-source={id}
                  onClick={() => setSource(id)}
                  className={`flex h-[50px] items-center gap-2.5 rounded-lg px-2.5 text-left ${active ? "bg-[var(--c-accent-dim)] text-[var(--c-text)]" : "text-[var(--c-text-secondary)] hover:bg-[var(--c-hover)]"}`}
                >
                  <span className={active ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)]"}>{sourceIcon(id)}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] font-medium ${id === "sshConfig" ? "font-mono" : ""}`}>{label}</span>
                    <span data-import-status="" className={`block truncate text-[11.5px] ${toneClass[s.tone]}`}>{s.text}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">{body()}</div>
        </div>
      </div>
    </div>
  );
}
