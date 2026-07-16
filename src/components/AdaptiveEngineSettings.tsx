import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Notice = { kind: "ok" | "err"; text: string } | null;

const inputClass =
  "w-full rounded-md bg-[var(--c-bg2)] px-2.5 py-1.5 text-[13px] text-[var(--c-text)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]";

/** Settings for the adaptive-snippet engine's Anthropic API key — stored in
 * the same vault as host secrets (`core::vault::store_anthropic_api_key`),
 * never round-tripped back to the frontend once saved. See
 * `core::adaptive` / `FleetTab.tsx`'s "Langage" mode. */
export function AdaptiveEngineSettings() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = () => api.hasAnthropicApiKey().then(setHasKey).catch(() => setHasKey(false));
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    if (!keyInput.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.setAnthropicApiKey(keyInput.trim());
      setKeyInput("");
      setNotice({ kind: "ok", text: "Clé enregistrée ✓" });
      refresh();
    } catch (e) {
      setNotice({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api.clearAnthropicApiKey();
      setNotice({ kind: "ok", text: "Clé supprimée." });
      refresh();
    } catch (e) {
      setNotice({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const noticeBanner = notice && (
    <p
      className={`rounded-md px-2.5 py-2 text-[12px] ${
        notice.kind === "ok"
          ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          : "border border-rose-500/30 bg-rose-500/10 text-rose-200"
      }`}
    >
      {notice.text}
    </p>
  );

  return (
    <div className="space-y-2 rounded-lg bg-[var(--c-bg3)] p-3">
      <p className="text-[13px] font-medium text-[var(--c-text)]">Moteur de snippets adaptatifs (IA)</p>
      <p className="text-[12px] leading-relaxed text-[var(--c-text-muted)]">
        Dans « Opérations de flotte », décrivez une intention (« installer node 24 ») et l'IA propose une commande
        par plateforme parmi les hôtes ciblés — toujours à relire et modifier avant exécution, rien ne part
        automatiquement. Nécessite une clé API Anthropic ; chaque génération consomme un peu de vos crédits API.
      </p>
      {hasKey === null ? (
        <p className="text-[12px] text-[var(--c-text-muted)]">Chargement…</p>
      ) : hasKey ? (
        <>
          <p className="flex items-center gap-2 text-[13px] text-[var(--c-text-secondary)]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" /> Clé API configurée
          </p>
          {noticeBanner}
          <button
            disabled={busy}
            onClick={clear}
            className="w-full rounded-md bg-rose-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            {busy ? "…" : "Supprimer la clé"}
          </button>
        </>
      ) : (
        <>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="sk-ant-…"
            spellCheck={false}
            className={inputClass}
          />
          {noticeBanner}
          <button
            disabled={busy || !keyInput.trim()}
            onClick={save}
            className="w-full rounded-md bg-[var(--c-accent)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--c-accent-hover)] disabled:opacity-50"
          >
            {busy ? "Enregistrement…" : "Enregistrer la clé"}
          </button>
        </>
      )}
    </div>
  );
}
