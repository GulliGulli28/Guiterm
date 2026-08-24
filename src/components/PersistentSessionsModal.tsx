import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Host, RunningSession, SessionListing } from "../lib/types";
import { describeSession } from "../lib/persistentSessions";
import { ConnectionPickerModal } from "./ConnectionPickerModal";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Ce qui tourne encore sur un hôte, et qu'on peut reprendre ou terminer.
 *
 * **Le trou que ça bouche.** Une session persistante survit à la fermeture de
 * son onglet — c'est le but : fermer l'app ne doit pas tuer le travail en
 * cours. Mais l'onglet disparu emportait la seule clé que l'app connaissait, et
 * la session continuait de tourner sur le serveur hors de portée de
 * l'interface. Rien n'était perdu, rien n'était atteignable non plus.
 *
 * **Réutilise `ConnectionPickerModal`** — la même chrome que les sélecteurs de
 * conteneurs Docker et de pods K8s, y compris ses actions par ligne, qui
 * existent justement pour qu'une ligne puisse porter autre chose que
 * « choisir celle-ci ».
 */

interface PersistentSessionsModalProps {
  host: Host;
  /** Ouvrir un terminal rattaché à cette session. */
  onResume: (sessionKey: string) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}

export function PersistentSessionsModal({ host, onResume, onClose, onError }: PersistentSessionsModalProps) {
  const [listing, setListing] = useState<SessionListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingKill, setPendingKill] = useState<RunningSession | null>(null);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    let disposed = false;
    setListing(null);
    setError(null);
    api.listPersistentSessions(host.id)
      .then((next) => { if (!disposed) setListing(next); })
      .catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [host.id]);

  const confirmKill = async (session: RunningSession) => {
    setKilling(true);
    try {
      setListing(await api.killPersistentSession(host.id, session.key));
    } catch (e) {
      onError?.(String(e));
    } finally {
      setKilling(false);
      setPendingKill(null);
    }
  };

  // La confirmation **remplace** le sélecteur au lieu de se poser dessus : deux
  // `useModalSurface` actifs en même temps se disputeraient Échap et le piège à
  // focus. L'état de la liste vit ici, donc elle revient telle quelle après.
  if (pendingKill) {
    const { name, meta } = describeSession(pendingKill);
    return (
      <ConfirmDialog
        title="Terminer cette session ?"
        message={
          `${name} — ${meta}. Ce qui y tourne s'arrête : un déploiement en cours, `
          + `un éditeur ouvert, une compilation. C'est irréversible, et l'hôte ne `
          + `demandera pas confirmation de son côté.`
        }
        confirmLabel={killing ? "Fermeture…" : "Terminer"}
        danger
        onConfirm={() => { if (!killing) void confirmKill(pendingKill); }}
        onCancel={() => { if (!killing) setPendingKill(null); }}
      />
    );
  }

  const sessions = listing?.sessions ?? [];
  return (
    <ConnectionPickerModal
      title={`Sessions persistantes — ${host.label}`}
      // Un hôte sans tmux ne peut pas *avoir* de session : le dire évite de lire
      // une liste vide comme « tout est propre ».
      warning={listing && !listing.tmuxAvailable ? "tmux n'est pas installé sur cet hôte : aucune session ne peut y survivre." : undefined}
      loading={listing === null && error === null}
      error={error}
      items={sessions.map((session) => {
        const { name, meta } = describeSession(session);
        return {
          id: session.key,
          name,
          meta,
          up: session.attached > 0,
          actions: [{
            label: "Terminer",
            title: "Ferme la session côté serveur et perd ce qui y tourne",
            run: () => setPendingKill(session),
          }],
        };
      })}
      onPick={(key) => { onResume(key); onClose(); }}
      onClose={onClose}
    />
  );
}
