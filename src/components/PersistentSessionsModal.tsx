import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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
  /** Ouvrir un terminal rattaché à cette session — en écriture, ou en simple
   * observation. */
  onResume: (sessionKey: string, readOnly?: boolean) => void;
  onClose: () => void;
  onError?: (message: string) => void;
  /** Retour visible d'une action qui ne change rien à l'écran — la commande de
   * partage copiée. */
  onNotify?: (message: string) => void;
}

export function PersistentSessionsModal({ host, onResume, onClose, onError, onNotify }: PersistentSessionsModalProps) {
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

  /** Met dans le presse-papiers la ligne qu'un collègue peut coller.
   *
   * L'app n'invite personne : rejoindre une session suppose d'avoir déjà un
   * accès SSH à l'hôte, et il n'y a pas de relais. Ce qu'elle peut faire, c'est
   * écrire la commande juste — le `-t` qui manque donne une erreur tmux qui ne
   * dit pas quoi corriger. */
  const copyShareCommand = async (session: RunningSession) => {
    try {
      const line = await api.persistentSessionShareCommand(host.id, session.key);
      await writeText(line);
      onNotify?.(`Commande copiée : ${line}`);
    } catch (e) {
      onError?.(String(e));
    }
  };

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
      wide
      // Deux choses qu'on ne peut pas laisser deviner. Un hôte sans tmux ne
      // peut pas *avoir* de session : sans le dire, une liste vide se lit
      // « tout est propre ». Et « Observer »/« Partager » ne protègent rien :
      // `tmux attach -r` empêche *ce client-là* de taper, pas quelqu'un
      // d'autre de s'attacher en écriture — il suffit d'avoir un shell sur
      // l'hôte. Le dire ici plutôt que dans une doc que personne n'ouvre.
      warning={
        listing && !listing.tmuxAvailable
          ? "tmux n'est pas installé sur cet hôte : aucune session ne peut y survivre."
          : sessions.length > 0
            ? "« Observer » et « Partager » ne sont pas une barrière de sécurité : toute personne ayant un shell sur cet hôte peut s'attacher à ces sessions en écriture."
            : undefined
      }
      loading={listing === null && error === null}
      error={error}
      items={sessions.map((session) => {
        const { name, meta } = describeSession(session);
        return {
          id: session.key,
          name,
          meta,
          up: session.attached > 0,
          actions: [
            {
              label: "Observer",
              title: "Ouvre la session en lecture seule : vos frappes ne sont pas envoyées, "
                + "et l'affichage adopte la taille de la session pour ne pas la redimensionner",
              run: () => { onResume(session.key, true); onClose(); },
            },
            {
              label: "Partager",
              title: "Copie la commande à donner à quelqu'un qui a déjà un accès SSH à cet hôte",
              run: () => void copyShareCommand(session),
            },
            {
              label: "Terminer",
              title: "Ferme la session côté serveur et perd ce qui y tourne",
              run: () => setPendingKill(session),
            },
          ],
        };
      })}
      onPick={(key) => { onResume(key); onClose(); }}
      onClose={onClose}
    />
  );
}
