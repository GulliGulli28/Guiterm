import { useEffect, useRef, useState } from "react";
import { api, onAzureLoginOutput } from "../lib/api";
import { readCloudFailure, type DescribedFailure } from "../lib/cloudFailure";
import { IconClose } from "./ui-icons";
import { cloudInputClass, CloudFailureNotice } from "./CloudImportBits";

interface AzureSignInPanelProps {
  onClose: () => void;
  /** Called once the sign-in succeeded, so the caller can reload its
   * subscription list without the user having to press anything. */
  onSignedIn: () => void;
  /** Pre-filled from the refusal that sent the user here — the CLI names the
   * tenant in its own error message, so nobody should have to copy a GUID. */
  initialTenant?: string | null;
}

type Stage = "form" | "signingIn" | "done";

/**
 * Signing in to Azure without leaving the app.
 *
 * **Why it exists.** An expired Azure session used to end the story: the panel
 * showed the CLI's refusal and told the user to go and run `az login`
 * somewhere else. This is the mirror of `AwsSsoSetupPanel`, which removed the
 * same dead end on the AWS side.
 *
 * The transcript is shown while the CLI waits, not after: `az login` prints a
 * verification URL — and the code, in device mode — then blocks until the
 * browser round trip is done. Those lines are the only way through when no
 * browser opens, so hiding them until the end would hide the useful part.
 */
export function AzureSignInPanel({ onClose, onSignedIn, initialTenant }: AzureSignInPanelProps) {
  const [tenant, setTenant] = useState(initialTenant ?? "");
  const [deviceCode, setDeviceCode] = useState(false);
  const [signOutFirst, setSignOutFirst] = useState(false);
  const [stage, setStage] = useState<Stage>("form");
  const [output, setOutput] = useState<string[]>([]);
  const [failure, setFailure] = useState<DescribedFailure | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // Subscribed for the whole panel's life rather than only during the sign-in:
  // the first lines arrive within milliseconds of the command starting, and a
  // listener attached after the call would miss exactly the ones worth showing.
  useEffect(() => {
    const pending = onAzureLoginOutput((line) => setOutput((previous) => [...previous, line]));
    return () => { pending.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => { outputEndRef.current?.scrollIntoView({ block: "end" }); }, [output]);

  const signIn = async () => {
    setStage("signingIn");
    setFailure(null);
    setOutput([]);
    try {
      // Signing out first is what makes reaching a *different* tenant work:
      // `az login` otherwise reuses the cached account, so someone switching
      // directories can re-authenticate repeatedly and keep landing on the
      // same subscriptions.
      if (signOutFirst) await api.azureLogout();
      await api.azureLogin(tenant.trim() || null, deviceCode);
      setStage("done");
      onSignedIn();
    } catch (e) {
      setFailure(readCloudFailure(e));
      setStage("form");
    }
  };

  // `stopPropagation` avant de fermer : ce panneau est rendu à l'intérieur de
  // l'overlay du panneau d'import, dont le fond ferme aussi au clic — sans ça,
  // cliquer à côté d'ici fermait les deux d'un coup.
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="flex max-h-full w-[min(38rem,100%)] flex-col overflow-hidden rounded-xl border border-[var(--c-border)] bg-[var(--c-bg2)] shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--c-border)] px-4 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-[var(--c-text)]">Se connecter à Azure</p>
            <p className="text-[11px] text-[var(--c-text-muted)]">
              Ouvre la session avec votre CLI <span className="font-mono">az</span>. Rien n'est
              stocké ici : le jeton va dans <span className="font-mono">~/.azure</span>, comme
              depuis un terminal, donc vos autres outils voient la même session.
            </p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-[var(--c-text-muted)] hover:bg-white/5 hover:text-[var(--c-text)]">
            <IconClose size={13} />
          </button>
        </div>

        {failure && <CloudFailureNotice failure={failure} />}

        {stage === "done" ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-[var(--c-text)]">Connecté.</p>
            <p className="mt-1 text-[11px] text-[var(--c-text-muted)]">
              La liste des abonnements a été rechargée.
            </p>
            <button onClick={onClose} className="accent-surface mt-4 rounded-md border px-4 py-1.5 text-xs font-medium">
              Fermer
            </button>
          </div>
        ) : (
          <div className="space-y-2.5 px-4 py-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--c-text-muted)]">
                Tenant <span className="font-normal text-[var(--c-text-faint)]">(facultatif)</span>
              </span>
              <input
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                placeholder="GUID ou contoso.onmicrosoft.com — vide = tenant par défaut"
                disabled={stage === "signingIn"}
                className={`${cloudInputClass} font-mono`}
              />
              <span className="block text-[10px] text-[var(--c-text-faint)]">
                {initialTenant
                  ? "Pré-rempli depuis le message d'erreur d'Azure."
                  : "À renseigner pour atteindre un autre annuaire que celui par défaut."}
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={signOutFirst}
                onChange={(e) => setSignOutFirst(e.target.checked)}
                disabled={stage === "signingIn"}
                className="mt-0.5 accent-[var(--c-accent)]"
              />
              <span className="text-[11px] text-[var(--c-text-secondary)]">
                Se déconnecter d'abord
                <span className="block text-[10px] text-[var(--c-text-faint)]">
                  Nécessaire pour changer de compte : sinon <span className="font-mono">az</span> réutilise
                  celui déjà en cache et vous retombez sur les mêmes abonnements.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={deviceCode}
                onChange={(e) => setDeviceCode(e.target.checked)}
                disabled={stage === "signingIn"}
                className="mt-0.5 accent-[var(--c-accent)]"
              />
              <span className="text-[11px] text-[var(--c-text-secondary)]">
                Utiliser un code d'appareil
                <span className="block text-[10px] text-[var(--c-text-faint)]">
                  À cocher si aucun navigateur ne s'ouvre : un code s'affiche ci-dessous, à saisir
                  depuis n'importe quel autre appareil.
                </span>
              </span>
            </label>

            <button
              onClick={signIn}
              disabled={stage === "signingIn"}
              className="accent-surface w-full rounded-md border py-2 text-sm font-medium disabled:opacity-40"
            >
              {stage === "signingIn" ? "Connexion en cours — terminez dans le navigateur…" : "Se connecter"}
            </button>

            {output.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-md bg-[var(--c-bg)] p-2">
                {output.map((line, i) => (
                  <p key={i} className="whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--c-text-secondary)]">
                    {line}
                  </p>
                ))}
                <div ref={outputEndRef} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
