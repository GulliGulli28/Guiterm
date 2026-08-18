import { useState } from "react";
import { api } from "../lib/api";
import { IconFlash } from "./ui-icons";

interface AdaptiveComposerProps {
  /** Le programme actuel : l'IA le reçoit pour pouvoir le *modifier* plutôt
   * que de repartir de zéro à chaque demande. */
  programText: string;
  /** Le programme réécrit. Toujours du texte dans la grammaire du DSL, jamais
   * du shell : c'est le même parseur que la saisie manuelle qui le validera. */
  onGenerated: (programText: string) => void;
  onError: (message: string) => void;
}

/**
 * « Décris ce que tu veux, l'IA écrit les lignes. »
 *
 * Extrait de `FleetTab`, où il était le seul endroit de l'app à exposer la
 * génération depuis le français. Conséquence : créer un snippet adaptatif
 * obligeait à connaître la grammaire du DSL par cœur, alors que la seule chose
 * qui la rend abordable existait déjà — à un onglet de distance, et sans que
 * rien ne le signale.
 *
 * Extrait plutôt que recopié : dupliquer vingt lignes de JSX et un appel API
 * aurait fait deux composeurs à faire évoluer ensemble, et ce dépôt vient d'en
 * faire les frais avec `sqlConnectionViaHostId`.
 *
 * L'IA n'écrit jamais de shell directement : elle rédige dans la grammaire du
 * DSL, et le texte produit passe par le même parseur que ce qu'on tape à la
 * main avant d'être montré. C'est ce qui rend l'assistance acceptable sur des
 * commandes qui vont s'exécuter sur une flotte.
 */
export function AdaptiveComposer({ programText, onGenerated, onError }: AdaptiveComposerProps) {
  const [intent, setIntent] = useState("");
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (generating) return;
    if (!intent.trim()) {
      onError("Décris ce que tu veux faire");
      return;
    }
    setGenerating(true);
    try {
      onGenerated(await api.generateAdaptiveProgram(programText, intent.trim()));
    } catch (e) {
      onError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--c-border)] bg-[var(--c-bg2)] p-1.5">
      <IconFlash size={13} className="ml-1 shrink-0 text-sky-400" />
      <input
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generate(); } }}
        placeholder="Décrire en français ce qu'ajouter/changer, et laisser l'IA écrire les lignes…"
        className="min-w-0 flex-1 bg-transparent text-xs text-[var(--c-text)] placeholder:text-[var(--c-text-faint)]"
      />
      <button
        onClick={generate}
        disabled={generating || !intent.trim()}
        className="shrink-0 rounded bg-[var(--c-accent-dim)] px-2.5 py-1 text-[11px] font-medium text-[var(--c-accent-text)] hover:bg-[var(--c-accent)] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {generating ? "Génération…" : "Générer"}
      </button>
    </div>
  );
}
