import { useEffect, useState, type ComponentProps } from "react";
import { api } from "../lib/api";
import { cloudCliStatus, probeCli, type CloudProbe, type ImportSource } from "../lib/importSources";
import { AwsIdentitiesPanel } from "./AwsIdentitiesPanel";
import { IconCloud, IconDownload, IconPlus } from "./ui-icons";

type CloudTab = "aws" | "gcp" | "azure";

interface CloudPageProps extends ComponentProps<typeof AwsIdentitiesPanel> {
  onImportHosts: (source: ImportSource) => void;
}

/**
 * Cloud : les accès utilisés pour importer des hôtes et ouvrir des tunnels
 * SSM, sur une page.
 *
 * AWS y a ses sessions SSO et ses profils (`AwsIdentitiesPanel`, qui tenait
 * dans la barre latérale). Google Cloud et Azure n'ont pas d'identités à
 * gérer ici — leurs CLI s'en chargent — mais la page dit où elles en sont,
 * comme la fenêtre d'import, et y mène.
 */
export function CloudPage({ onImportHosts, ...aws }: CloudPageProps) {
  const [tab, setTab] = useState<CloudTab>("aws");
  const [gcp, setGcp] = useState<CloudProbe>(null);
  const [azure, setAzure] = useState<CloudProbe>(null);
  useEffect(() => probeCli(api.listGcpProjects, setGcp), []);
  useEffect(() => probeCli(api.listAzureSubscriptions, setAzure), []);
  const gcpStatus = cloudCliStatus("gcloud", gcp, ["projet", "projets"]);
  const azureStatus = cloudCliStatus("az", azure, ["abonnement", "abonnements"]);

  const tabs: { id: CloudTab; label: string; status?: { tone: string; text: string } }[] = [
    { id: "aws", label: "AWS" },
    { id: "gcp", label: "Google Cloud", status: gcpStatus },
    { id: "azure", label: "Azure", status: azureStatus },
  ];

  return (
    <div data-page="cloud" className="sidebar-scroll h-full overflow-y-auto bg-[var(--c-bg2)]">
      <div className="mx-auto max-w-[1040px] space-y-5 px-9 py-7">
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold text-[var(--c-text)]">Identités cloud</h1>
            <p className="mt-1 text-[12.5px] text-[var(--c-text-muted)]">Les accès utilisés pour l'import d'hôtes et les tunnels SSM.</p>
          </div>
          <button type="button" onClick={() => onImportHosts(tab)} className="btn btn-secondary">
            <IconDownload size={13} /> Importer des hôtes
          </button>
          {tab === "aws" && (
            <button type="button" onClick={aws.onConfigureSso} className="btn btn-primary">
              <IconPlus size={13} /> Nouvelle session SSO
            </button>
          )}
        </div>

        <div role="tablist" className="flex gap-1 border-b border-[var(--c-border)]">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-cloud-tab={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] ${
                tab === t.id ? "border-[var(--c-accent)] font-medium text-[var(--c-text)]" : "border-transparent text-[var(--c-text-muted)] hover:text-[var(--c-text)]"
              }`}
            >
              {t.label}
              {t.status && t.status.tone === "warn" && <span className="chip chip-warn h-[18px]">{t.status.text}</span>}
            </button>
          ))}
        </div>

        {tab === "aws" && (
          <div data-cloud-aws>
            <AwsIdentitiesPanel {...aws} inPage />
          </div>
        )}
        {tab !== "aws" && (
          <CliCard
            name={tab === "gcp" ? "Google Cloud" : "Azure"}
            program={tab === "gcp" ? "gcloud" : "az"}
            status={tab === "gcp" ? gcpStatus : azureStatus}
            login={tab === "gcp" ? "gcloud auth login" : "az login"}
            onImport={() => onImportHosts(tab)}
          />
        )}
      </div>
    </div>
  );
}

function CliCard({ name, program, status, login, onImport }: {
  name: string;
  program: string;
  status: { tone: "ok" | "warn" | "muted"; text: string };
  login: string;
  onImport: () => void;
}) {
  return (
    <section className="card flex items-center gap-3 p-4" data-cloud-cli={program}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconCloud size={16} /></span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--c-text)]">
          {name}
          <span className={`chip ${status.tone === "ok" ? "chip-ok" : status.tone === "warn" ? "chip-warn" : ""}`}>{status.text}</span>
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--c-text-muted)]">
          Guiterm utilise la CLI <span className="font-mono">{program}</span> de ce poste ; ses comptes se gèrent avec elle
          (<span className="font-mono">{login}</span>).
        </p>
      </div>
      <button type="button" onClick={onImport} className="btn btn-secondary">
        <IconDownload size={13} /> Importer des hôtes
      </button>
    </section>
  );
}
