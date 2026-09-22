import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api } from "../lib/api";
import { copySecret } from "../lib/secretClipboard";
import type { GuiVaultBrowseEntry, GuiVaultBrowseField, GuiVaultStatus } from "../lib/types";
import { BROWSE_FILTERS, browseSections, countByKind, type BrowseFilter } from "../lib/vaultBrowse";
import { KIND_LABELS, buildVaultTreeSections, visibleRows, type VaultTreeRow } from "../lib/vaultTree";
import { EntityRow, EntityTags, GroupRow } from "./EntityRow";
import { KIND_ICONS } from "./VaultEntityTree";
import { IconClose, IconCopy, IconFolder, IconKeychain, IconLock, IconPaste, IconRefresh, IconReturn, IconSnippets, IconVault } from "./ui-icons";

/**
 * Coller depuis GuiVault — la colonne à droite du terminal actif.
 *
 * Le contenu du **compte** (le serveur, pas le workspace affiché : en vue
 * « Cet appareil » on veut quand même ses mots de passe), tout type confondu,
 * dans la même arborescence que le panneau GuiVault et que l'extension web :
 * une section par vault, les dossiers repliables, clés et snippets dans leur
 * compartiment, et les secrets de l'interface web (identifiants, notes,
 * cartes, identités) rangés par dossier comme les hôtes. Un filtre par type
 * et une recherche (nom, chemin, utilisateur, adresse, site, tags).
 *
 * Un item cliqué se déplie **en place** et montre ses champs — jamais leurs
 * valeurs : chaque bouton demande la sienne au moment de l'appui
 * (`guivaultBrowseField`), puis la copie (effacée au bout de trente
 * secondes, `copySecret`) ou la colle dans le terminal actif, avec ou sans
 * Entrée derrière. Un code TOTP s'affiche en direct avec son compte à
 * rebours.
 *
 * Au clavier : la recherche a le focus à l'ouverture ; ↑/↓ parcourent les
 * items, Entrée déplie celui sous le curseur et pose le focus sur son
 * premier « Coller », Échap vide la recherche puis ferme le panneau. La
 * palette (`vault.paste`) offre le même contenu en deux listes successives
 * pour qui ne veut pas quitter le terminal des yeux.
 */
interface VaultBrowserPanelProps {
  status: GuiVaultStatus | null;
  /** Le terminal dans lequel « Coller » écrira, ou `null` si l'onglet actif
   * n'en est pas un — les boutons le disent plutôt que d'écrire dans le
   * vide. */
  targetLabel: string | null;
  onPaste: (text: string, enter: boolean) => void;
  onNotify: (message: string) => void;
  onError: (message: string) => void;
  /** Ouvrir le panneau GuiVault de la barre latérale (se connecter,
   * déverrouiller). */
  onOpenAccount: () => void;
  onClose: () => void;
}

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; entries: GuiVaultBrowseEntry[] };

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = { "Clés": IconKeychain, "Snippets": IconSnippets };

export function VaultBrowserPanel({ status, targetLabel, onPaste, onNotify, onError, onOpenAccount, onClose }: VaultBrowserPanelProps) {
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BrowseFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  /** L'item sous le curseur clavier (un id d'entité), ou `null`. */
  const [cursor, setCursor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const firstPasteRef = useRef<HTMLButtonElement>(null);
  const focusFirstPaste = useRef(false);

  const usable = !!status?.configured && !!status.unlocked;

  const reload = useCallback(() => {
    if (!usable) return;
    setLoad((prev) => (prev.state === "ready" ? prev : { state: "loading" }));
    api.guivaultBrowse()
      .then((entries) => setLoad({ state: "ready", entries }))
      .catch((e) => setLoad({ state: "error", message: String(e) }));
  }, [usable]);

  useEffect(() => { reload(); }, [reload]);
  // Une synchro vient de passer : ce qui a bougé sur le serveur est relu
  // (le cache ne retélécharge que les vaults dont la révision a changé).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    api.onGuivaultSynced(() => reload()).then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, [reload]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const entries = useMemo(() => (load.state === "ready" ? load.entries : []), [load]);
  const counts = useMemo(() => countByKind(entries), [entries]);
  const filters = BROWSE_FILTERS.filter((f) => (counts[f.kind] ?? 0) > 0);
  const rows = useMemo(() => buildVaultTreeSections(browseSections(entries, filter), query).rows, [entries, filter, query]);
  const visible = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const entityRows = useMemo(() => visible.filter((r): r is Extract<VaultTreeRow, { kind: "entity" }> => r.kind === "entity" && r.entity.kind !== "group"), [visible]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  // Le curseur suit la liste : un filtre qui le fait disparaître le ramène
  // sur le premier item.
  useEffect(() => {
    if (entityRows.length === 0) { setCursor(null); return; }
    if (!cursor || !entityRows.some((r) => r.id === cursor)) setCursor(entityRows[0].id);
  }, [entityRows, cursor]);

  useEffect(() => {
    if (focusFirstPaste.current && openId) {
      focusFirstPaste.current = false;
      firstPasteRef.current?.focus();
    }
  }, [openId]);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveCursor = (delta: number) => {
    if (entityRows.length === 0) return;
    const idx = Math.max(0, entityRows.findIndex((r) => r.id === cursor));
    const next = entityRows[Math.min(entityRows.length - 1, Math.max(0, idx + delta))];
    setCursor(next.id);
    document.querySelector(`[data-browse-entity="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  // Pas de `stopPropagation` : les raccourcis de l'app (dont celui qui ferme
  // ce panneau) doivent passer, la recherche ne s'approprie que ses touches.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!cursor) return;
      if (openId === cursor) setOpenId(null);
      else { focusFirstPaste.current = true; setOpenId(cursor); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else onClose();
    }
  };

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-3 py-2">
      <IconVault size={15} className="shrink-0 text-[var(--c-accent)]" />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--c-text)]">Coller depuis GuiVault</h2>
      {usable && (
        <button onClick={reload} title="Relire les vaults" aria-label="Relire les vaults" className="btn btn-ghost btn-sm btn-icon">
          <IconRefresh size={13} />
        </button>
      )}
      <button onClick={onClose} title="Fermer (Échap)" aria-label="Fermer le panneau GuiVault" className="btn btn-ghost btn-sm btn-icon">
        <IconClose size={12} />
      </button>
    </div>
  );

  if (!usable) {
    const locked = !!status?.configured;
    return (
      <div className="flex h-full flex-col" data-vault-browser="">
        {header}
        <div className="flex flex-1 select-none flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--c-border)] bg-[var(--c-bg2)] text-[var(--c-text-muted)]">
            {locked ? <IconLock size={18} /> : <IconVault size={18} />}
          </div>
          <p className="text-[13px] font-medium text-[var(--c-text-secondary)]">
            {locked ? "Compte GuiVault verrouillé" : "Aucun compte GuiVault"}
          </p>
          <p className="text-[12px] leading-relaxed text-[var(--c-text-muted)]">
            {locked
              ? "Saisissez le mot de passe maître pour parcourir vos vaults et coller un secret dans le terminal."
              : "Connectez un compte GuiVault pour parcourir vos vaults et coller un secret dans le terminal."}
          </p>
          <button onClick={onOpenAccount} className="btn btn-primary mt-1">
            {locked ? "Déverrouiller" : "Se connecter"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-vault-browser="">
      {header}
      <div className="shrink-0 border-b border-[var(--c-border)] px-3 py-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Rechercher — nom, utilisateur, site, tag…"
          aria-label="Rechercher dans les vaults"
          className="input w-full"
        />
        {filters.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1">
            <button onClick={() => setFilter("all")} className={`btn btn-sm ${filter === "all" ? "btn-toggled" : "btn-ghost"}`} aria-pressed={filter === "all"}>
              Tous
            </button>
            {filters.map((f) => (
              <button key={f.kind} onClick={() => setFilter(f.kind)} className={`btn btn-sm ${filter === f.kind ? "btn-toggled" : "btn-ghost"}`} aria-pressed={filter === f.kind}>
                {f.label} <span className="text-[var(--c-text-muted)]">{counts[f.kind]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {load.state === "loading" && <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">Lecture des vaults…</p>}
        {load.state === "error" && (
          <div className="callout callout-danger m-2">
            <p className="text-[12px]">{load.message}</p>
            <button onClick={reload} className="btn btn-sm mt-2">Réessayer</button>
          </div>
        )}
        {load.state === "ready" && rows.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">
            {entries.length === 0 ? "Ce compte n'a encore rien dans ses vaults." : "Aucun résultat."}
          </p>
        )}
        {load.state === "ready" && visible.map((row) => {
          if (row.kind === "section") {
            return <GroupRow key={row.id} depth={row.depth} expanded={!collapsed.has(row.id)} onToggle={() => toggleCollapsed(row.id)} icon={<IconVault size={14} />} name={row.name} count={row.count} />;
          }
          if (row.kind === "folder") {
            return <GroupRow key={row.id} depth={row.depth} expanded={!collapsed.has(row.id)} onToggle={() => toggleCollapsed(row.id)} icon={<IconFolder size={14} />} name={row.entity.name} count={row.keys.length - 1} />;
          }
          if (row.kind === "bucket") {
            const Icon = BUCKET_ICONS[row.label] ?? IconFolder;
            return <GroupRow key={row.id} depth={row.depth} expanded={!collapsed.has(row.id)} onToggle={() => toggleCollapsed(row.id)} icon={<Icon size={14} />} name={row.label} count={row.keys.length} />;
          }
          const { entity } = row;
          const entry = byId.get(entity.id);
          if (!entry) return null;
          const Icon = KIND_ICONS[entity.kind];
          const open = openId === entity.id;
          const hint = entry.search.split(" ").find((s) => s && !s.startsWith("http")) ?? "";
          return (
            <EntityRow
              key={row.id}
              depth={row.depth}
              active={open || cursor === entity.id}
              className="cursor-pointer"
              dataAttrs={{ "data-browse-entity": entity.id, "data-vault-entity": entity.name }}
              icon={<Icon size={13} />}
              title={entity.name}
              title_={`${KIND_LABELS[entity.kind]}${entity.path ? ` — ${entity.path}` : ""}`}
              secondary={(hint || entry.tags.length > 0) ? (
                <>
                  {hint && <span className="truncate">{hint}</span>}
                  <EntityTags tags={entry.tags} />
                </>
              ) : undefined}
              onClick={() => { setCursor(entity.id); setOpenId(open ? null : entity.id); }}
            >
              {open && (
                <FieldList
                  entry={entry}
                  targetLabel={targetLabel}
                  firstPasteRef={firstPasteRef}
                  onPaste={onPaste}
                  onNotify={onNotify}
                  onError={onError}
                />
              )}
            </EntityRow>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--c-border)] px-3 py-1.5 text-[11.5px] text-[var(--c-text-muted)]">
        {targetLabel ? <>Coller écrit dans <span className="text-[var(--c-text-secondary)]">{targetLabel}</span>.</> : "Aucun terminal actif — seul « Copier » est possible."}
      </div>
    </div>
  );
}

// ─── Les champs d'un item déplié ────────────────────────────────────────────

interface FieldListProps {
  entry: GuiVaultBrowseEntry;
  targetLabel: string | null;
  firstPasteRef: RefObject<HTMLButtonElement | null>;
  onPaste: (text: string, enter: boolean) => void;
  onNotify: (message: string) => void;
  onError: (message: string) => void;
}

function FieldList({ entry, targetLabel, firstPasteRef, onPaste, onNotify, onError }: FieldListProps) {
  const read = (field: GuiVaultBrowseField): Promise<string> =>
    field.totp
      ? api.guivaultBrowseTotp(entry.vaultId, entry.id).then((t) => t.code)
      : api.guivaultBrowseField(entry.vaultId, entry.id, field.key);

  const copy = (field: GuiVaultBrowseField) =>
    read(field)
      .then((v) => copySecret(v))
      .then(() => onNotify(field.secret ? `${field.label} copié — effacé du presse-papiers dans 30 s.` : `${field.label} copié.`))
      .catch((e) => onError(String(e)));

  const paste = (field: GuiVaultBrowseField, enter: boolean) =>
    read(field)
      .then((v) => onPaste(v, enter))
      .catch((e) => onError(String(e)));

  if (entry.fields.length === 0) {
    return <p className="px-1 pb-1 text-[11.5px] text-[var(--c-text-muted)]">Rien à copier dans cet item.</p>;
  }
  return (
    <ul className="mb-1 flex flex-col gap-0.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg)] p-1" data-browse-fields="">
      {entry.fields.map((field, i) => (
        <li key={field.key} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--c-hover)]">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-[var(--c-text)]">{field.label}</span>
            {field.totp ? (
              <TotpValue vaultId={entry.vaultId} id={entry.id} />
            ) : (
              <span className="block truncate font-mono text-[11px] text-[var(--c-text-muted)]">
                {field.secret ? "••••••••" : field.multiline ? "plusieurs lignes" : ""}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <button onClick={() => copy(field)} title={`Copier — ${field.label}`} aria-label={`Copier ${field.label}`} className="btn btn-ghost btn-sm btn-icon">
              <IconCopy size={13} />
            </button>
            <button
              ref={i === 0 ? firstPasteRef : undefined}
              onClick={() => paste(field, false)}
              disabled={!targetLabel}
              title={targetLabel ? `Coller dans ${targetLabel} — ${field.label}` : "Aucun terminal actif"}
              aria-label={`Coller ${field.label}`}
              className="btn btn-ghost btn-sm btn-icon"
            >
              <IconPaste size={13} />
            </button>
            <button
              onClick={() => paste(field, true)}
              disabled={!targetLabel}
              title={targetLabel ? `Coller puis Entrée dans ${targetLabel} — ${field.label}` : "Aucun terminal actif"}
              aria-label={`Coller ${field.label} puis Entrée`}
              className="btn btn-ghost btn-sm btn-icon"
            >
              <IconReturn size={13} />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Le code TOTP en direct : un compte à rebours d'une seconde, et le code
 * relu quand il tombe à zéro. */
function TotpValue({ vaultId, id }: { vaultId: string; id: string }) {
  const [code, setCode] = useState<{ code: string } | { error: string } | null>(null);
  const [ttl, setTtl] = useState(0);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.guivaultBrowseTotp(vaultId, id)
      .then((t) => { if (!cancelled) { setCode({ code: t.code }); setTtl(t.ttlSecs); } })
      .catch((e) => { if (!cancelled) setCode({ error: String(e) }); });
    return () => { cancelled = true; };
  }, [vaultId, id, epoch]);
  useEffect(() => {
    if (ttl <= 0) return;
    const t = window.setTimeout(() => setTtl(ttl - 1), 1000);
    return () => window.clearTimeout(t);
  }, [ttl]);
  useEffect(() => {
    if (ttl === 0 && code && !("error" in code)) setEpoch((e) => e + 1);
  }, [ttl, code]);
  if (!code) return <span className="block font-mono text-[11px] text-[var(--c-text-muted)]">…</span>;
  if ("error" in code) return <span className="block truncate text-[11px] text-[var(--c-danger)]">{code.error}</span>;
  return (
    <span className="flex items-center gap-2 font-mono text-[12px] text-[var(--c-text)]" data-totp-code={code.code}>
      {code.code.replace(/^(\d{3})(\d+)$/, "$1 $2")}
      <span className="text-[10.5px] text-[var(--c-text-muted)]">{ttl} s</span>
    </span>
  );
}
