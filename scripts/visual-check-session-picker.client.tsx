// Monte un vrai `ConnectionPickerModal` avec les lignes que le gestionnaire de
// sessions persistantes lui donne. Aucun Tauri : ce composant ne parle qu'à ses
// callbacks.
//
// Piloté par `visual-check-session-picker.mjs`, qui mesure si le texte des
// lignes est rogné — ce qui était le cas à la largeur d'origine, celle d'une
// liste de conteneurs où le nom suffit : ici chaque ligne porte deux lignes de
// texte *et* trois actions, qui occupent leur largeur même hors survol.
import { createRoot } from "react-dom/client";
import { ConnectionPickerModal } from "../src/components/ConnectionPickerModal";
import { describeSession } from "../src/lib/persistentSessions";
import type { RunningSession } from "../src/lib/types";
import "../src/index.css";

const hourAgo = Date.now() - 2 * 3600 * 1000;

/** Les cas les plus longs que la modale puisse avoir à rendre : plusieurs
 * fenêtres, plusieurs clients attachés, et le libellé « détachée » avec son
 * explication — c'est elle qui rend le mot compréhensible à qui ne connaît pas
 * tmux, donc elle ne doit pas disparaître dans un « … ». */
const sessions: RunningSession[] = [
  { key: "guiterm-1", createdAtMs: hourAgo, windows: 1, attached: 0, width: 200, height: 50 },
  { key: "guiterm-2", createdAtMs: hourAgo, windows: 12, attached: 3, width: 200, height: 50 },
  { key: "guiterm-3", createdAtMs: null, windows: 1, attached: 1, width: null, height: null },
];

createRoot(document.getElementById("host")!).render(
  <ConnectionPickerModal
    title="Sessions persistantes — bastion-production-eu-west"
    wide
    warning="« Observer » et « Partager » ne sont pas une barrière de sécurité : toute personne ayant un shell sur cet hôte peut s'attacher à ces sessions en écriture."
    loading={false}
    items={sessions.map((session) => {
      const { name, meta } = describeSession(session);
      return {
        id: session.key,
        name,
        meta,
        up: session.attached > 0,
        actions: [
          { label: "Observer", run: () => {} },
          { label: "Partager", run: () => {} },
          { label: "Terminer", run: () => {} },
        ],
      };
    })}
    onPick={() => {}}
    onClose={() => {}}
  />,
);
