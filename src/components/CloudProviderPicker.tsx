import { IconClose } from "./ui-icons";

/** Which import panel the picker opens. */
export type CloudProvider = "aws" | "azure" | "gcp";

const PROVIDERS: { id: CloudProvider; name: string; cli: string; detail: string }[] = [
  {
    id: "aws",
    name: "AWS",
    cli: "aws",
    detail: "Instances EC2, avec la commande proxy SSM et le login déduit de l'AMI.",
  },
  {
    id: "azure",
    name: "Azure",
    cli: "az",
    detail: "VM d'un abonnement, avec leurs adresses et leur administrateur.",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    cli: "gcloud",
    detail: "Instances Compute Engine d'un projet, étiquettes et tags réseau compris.",
  },
];

/**
 * One step before the provider's own panel.
 *
 * Exists so the "Ajouter…" menu keeps one cloud entry instead of one per
 * provider — three of six items saying "Importer depuis …" pushed the ordinary
 * actions (new host, new folder) down a list nobody reads to the end. The
 * panels themselves stay separate: this only routes.
 */
export function CloudProviderPicker({
  onPick,
  onClose,
}: {
  onPick: (provider: CloudProvider) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-[min(30rem,100%)] overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Importer depuis le cloud</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Chaque import passe par la CLI que vous avez déjà configurée — aucun identifiant
              cloud n'est demandé ni conservé.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        <div className="space-y-1 p-2">
          {PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              onClick={() => onPick(provider.id)}
              // Each entry's label is a name, a CLI hint and a sentence, so
              // there is no exact string to match on. `data-provider` gives the
              // E2E scenario an unambiguous handle that reads as intent rather
              // than as a brittle text selector.
              data-provider={provider.id}
              aria-label={`Importer depuis ${provider.name}`}
              className="block w-full rounded-lg px-3 py-2.5 text-left hover:bg-[var(--c-bg3)]"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-[var(--c-text)]">{provider.name}</span>
                <span className="font-mono text-[10px] text-[var(--c-text-faint)]">{provider.cli}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--c-text-muted)]">{provider.detail}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
