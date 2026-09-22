import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { copySecret } from "../lib/secretClipboard";
import type { GuiVaultBrowseEntry, GuiVaultBrowseValue, GuiVaultStatus } from "../lib/types";
import { BROWSE_FILTERS, browseSections, countByKind, type BrowseFilter } from "../lib/vaultBrowse";
import { KIND_LABELS, buildVaultTreeSections, visibleRows, type VaultTreeRow } from "../lib/vaultTree";
import { EntityRow, EntityTags, GroupRow } from "./EntityRow";
import { KIND_ICONS } from "./VaultEntityTree";
import { IconClose, IconCopy, IconEye, IconEyeOff, IconFolder, IconKeychain, IconLock, IconPaste, IconRefresh, IconReturn, IconSnippets, IconVault } from "./ui-icons";

/**
 * Coller depuis GuiVault — la colonne à droite du terminal actif.
 *
 * Le contenu du **compte** (le serveur, pas le workspace affiché : en vue
 * « Cet appareil » on veut quand même ses mots de passe), tout type confondu,
 * dans la même arborescence que le panneau GuiVault et que l'extension web :
 * une section par vault, les dossiers repliables, clés et snippets dans leur
 * compartiment, et les secrets de l'interface web (identifiants, notes,
 * cartes, identités) rangés par dossier comme les hôtes. Un filtre par type
 * (qui ne garde que les dossiers qui en contiennent) et une recherche (nom,
 * chemin, utilisateur, adresse, site, tags).
 *
 * Un item ouvert se déplie **en place** et montre ses champs avec leurs
 * valeurs (`guivaultBrowseItem`, demandées à l'ouverture, oubliées à la
 * fermeture) — un secret masqué, révélable à l'œil. Par champ : Copier
 * (effacé du presse-papiers après trente secondes, `copySecret`), Coller,
 * Coller puis Entrée. Un code TOTP s'affiche en direct avec son compte à
 * rebours.
 *
 * **Au clavier, une seule zone de navigation : l'arbre.** La recherche a le
 * focus à l'ouverture ; ↓ (ou Entrée) passe à l'arbre, qui garde le focus
 * ensuite quoi qu'on fasse — les boutons ne sont jamais focalisés, et un
 * collage depuis le clavier ne rend pas le focus au terminal (on colle
 * souvent plusieurs champs d'affilée). Dans l'arbre : ↑/↓ parcourent items
 * et champs, →/Entrée ouvre un item, ← le referme, Entrée sur un champ le
 * colle, Maj+Entrée le colle puis Entrée, Ctrl+C le copie, Espace révèle
 * ou masque un secret, Échap revient à la recherche, et une lettre y
 * retourne en la tapant. La palette (`vault.paste`) offre le même contenu
 * en deux listes pour qui préfère.
 */
interface VaultBrowserPanelProps {
  status: GuiVaultStatus | null;
  /** Le terminal dans lequel « Coller » écrira, ou `null` si l'onglet actif
   * n'en est pas un — les boutons le disent plutôt que d'écrire dans le
   * vide. */
  targetLabel: string | null;
  /** `focusTerminal` : rendre le focus au terminal après — oui pour un clic
   * à la souris, non depuis le clavier de l'arbre. */
  onPaste: (text: string, enter: boolean, focusTerminal: boolean) => void;
  onNotify: (message: string) => void;
  onError: (message: string) => void;
  /** Ouvrir le panneau GuiVault de la barre latérale (se connecter,
   * déverrouiller). */
  onOpenAccount: () => void;
  onClose: () => void;
}

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; entries: GuiVaultBrowseEntry[] };
type Values = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; values: GuiVaultBrowseValue[] };

/** Où est le curseur clavier : sur l'en-tête d'un item, ou sur l'un de ses
 * champs (l'item est alors ouvert). */
interface Cursor { id: string; field: number | null }

const BUCKET_ICONS: Record<string, (p: { size?: number }) => ReactNode> = { "Clés": IconKeychain, "Snippets": IconSnippets };

export function VaultBrowserPanel({ status, targetLabel, onPaste, onNotify, onError, onOpenAccount, onClose }: VaultBrowserPanelProps) {
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BrowseFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({ state: "loading" });
  /** Les secrets révélés de l'item ouvert, par clé de champ. */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [treeFocused, setTreeFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

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
  const openEntry = openId ? byId.get(openId) ?? null : null;

  // Les valeurs de l'item ouvert : demandées à l'ouverture, oubliées à la
  // fermeture (et les secrets révélés avec).
  useEffect(() => {
    setRevealed(new Set());
    if (!openEntry) return;
    let cancelled = false;
    setValues({ state: "loading" });
    api.guivaultBrowseItem(openEntry.vaultId, openEntry.id)
      .then((v) => { if (!cancelled) setValues({ state: "ready", values: v }); })
      .catch((e) => { if (!cancelled) setValues({ state: "error", message: String(e) }); });
    return () => { cancelled = true; };
  }, [openEntry]);

  // Le curseur suit la liste : un filtre qui fait disparaître son item le
  // ramène sur le premier ; l'item ouvert qui disparaît se referme.
  useEffect(() => {
    if (entityRows.length === 0) { setCursor(null); return; }
    if (!cursor || !entityRows.some((r) => r.id === cursor.id)) setCursor({ id: entityRows[0].id, field: null });
  }, [entityRows, cursor]);
  useEffect(() => {
    if (openId && !entityRows.some((r) => r.id === openId)) setOpenId(null);
  }, [entityRows, openId]);
  useEffect(() => {
    if (!cursor) return;
    const target = cursor.field === null
      ? `[data-browse-entity="${cursor.id}"]`
      : `[data-browse-entity="${cursor.id}"] [data-browse-field-index="${cursor.field}"]`;
    treeRef.current?.querySelector(target)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fieldCount = (id: string) => (openId === id && values.state === "ready" ? values.values.length : 0);

  /** Un pas de curseur, à travers les en-têtes et les champs de l'item
   * ouvert, comme une seule liste. */
  const moveCursor = (delta: 1 | -1) => {
    if (entityRows.length === 0) return;
    const idx = Math.max(0, entityRows.findIndex((r) => r.id === cursor?.id));
    const id = entityRows[idx].id;
    const field = cursor?.field ?? null;
    const n = fieldCount(id);
    if (delta === 1) {
      if (field === null && n > 0) setCursor({ id, field: 0 });
      else if (field !== null && field < n - 1) setCursor({ id, field: field + 1 });
      else if (idx < entityRows.length - 1) setCursor({ id: entityRows[idx + 1].id, field: null });
      return;
    }
    if (field !== null) {
      setCursor({ id, field: field > 0 ? field - 1 : null });
    } else if (idx > 0) {
      const prev = entityRows[idx - 1].id;
      const m = fieldCount(prev);
      setCursor({ id: prev, field: m > 0 ? m - 1 : null });
    }
  };

  const focusTree = () => {
    if (!cursor && entityRows.length > 0) setCursor({ id: entityRows[0].id, field: null });
    treeRef.current?.focus();
  };

  const openItem = (id: string) => {
    if (openId === id) return;
    setOpenId(id);
    setCursor({ id, field: null });
  };

  // ── Actions sur un champ ──────────────────────────────────────────────
  const valueOf = (entry: GuiVaultBrowseEntry, fv: GuiVaultBrowseValue): Promise<string> =>
    fv.totp ? api.guivaultBrowseTotp(entry.vaultId, entry.id).then((t) => t.code) : Promise.resolve(fv.value);

  const copy = (entry: GuiVaultBrowseEntry, fv: GuiVaultBrowseValue) =>
    valueOf(entry, fv)
      .then((v) => copySecret(v))
      .then(() => onNotify(fv.secret ? `${fv.label} copié — effacé du presse-papiers dans 30 s.` : `${fv.label} copié.`))
      .catch((e) => onError(String(e)));

  const paste = (entry: GuiVaultBrowseEntry, fv: GuiVaultBrowseValue, enter: boolean, focusTerminal: boolean) =>
    valueOf(entry, fv)
      .then((v) => onPaste(v, enter, focusTerminal))
      .catch((e) => onError(String(e)));

  const toggleReveal = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const currentField = (): { entry: GuiVaultBrowseEntry; fv: GuiVaultBrowseValue } | null => {
    if (!cursor || cursor.field === null || !openEntry || openEntry.id !== cursor.id || values.state !== "ready") return null;
    const fv = values.values[cursor.field];
    return fv ? { entry: openEntry, fv } : null;
  };

  // ── Clavier ───────────────────────────────────────────────────────────
  // Pas de `stopPropagation` : les raccourcis de l'app (dont celui qui ferme
  // ce panneau) doivent passer, chaque zone ne s'approprie que ses touches.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); focusTree(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      focusTree();
      const first = cursor?.id ?? entityRows[0]?.id;
      if (first) openItem(first);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else onClose();
    }
  };

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Un bouton cliqué à la souris peut avoir le focus : Entrée et Espace
    // sont alors à lui, pas à l'arbre.
    const onSelf = e.target === e.currentTarget;
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); treeRef.current?.focus(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); treeRef.current?.focus(); return; }
    if (e.key === "Escape") { e.preventDefault(); inputRef.current?.focus(); return; }
    if (!cursor) return;
    const field = currentField();
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (cursor.field === null) openItem(cursor.id);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (cursor.field !== null) setCursor({ id: cursor.id, field: null });
      else if (openId === cursor.id) setOpenId(null);
      return;
    }
    if (e.key === "Enter" && onSelf) {
      e.preventDefault();
      if (field) paste(field.entry, field.fv, e.shiftKey, false);
      else if (openId === cursor.id) setOpenId(null);
      else openItem(cursor.id);
      return;
    }
    if (e.key === " " && onSelf) {
      e.preventDefault();
      if (field?.fv.secret && !field.fv.totp) toggleReveal(field.fv.key);
      else if (!field) { if (openId === cursor.id) setOpenId(null); else openItem(cursor.id); }
      return;
    }
    if (e.key === "c" && (e.ctrlKey || e.metaKey) && field) {
      e.preventDefault();
      copy(field.entry, field.fv);
      return;
    }
    // Une lettre : c'est la recherche qu'on veut — elle reprend le focus et
    // la touche, que l'arbre a interceptée.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      e.preventDefault();
      setQuery((q) => q + e.key);
      inputRef.current?.focus();
    }
  };

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-3 py-2">
      <IconVault size={15} className="shrink-0 text-[var(--c-accent)]" />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--c-text)]">Coller depuis GuiVault</h2>
      {usable && (
        <button onClick={reload} title="Relire les vaults" aria-label="Relire les vaults" tabIndex={-1} className="btn btn-ghost btn-sm btn-icon">
          <IconRefresh size={13} />
        </button>
      )}
      <button onClick={onClose} title="Fermer (Échap)" aria-label="Fermer le panneau GuiVault" tabIndex={-1} className="btn btn-ghost btn-sm btn-icon">
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
            <button onClick={() => setFilter("all")} tabIndex={-1} className={`btn btn-sm ${filter === "all" ? "btn-toggled" : "btn-ghost"}`} aria-pressed={filter === "all"}>
              Tous
            </button>
            {filters.map((f) => (
              <button key={f.kind} onClick={() => setFilter(f.kind)} tabIndex={-1} className={`btn btn-sm ${filter === f.kind ? "btn-toggled" : "btn-ghost"}`} aria-pressed={filter === f.kind}>
                {f.label} <span className="text-[var(--c-text-muted)]">{counts[f.kind]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* L'arbre est la zone focalisable ; ses boutons ne le sont pas
          (`tabIndex={-1}`), pour que Tab n'y perde pas le curseur. */}
      <div
        ref={treeRef}
        tabIndex={0}
        role="tree"
        aria-label="Contenu des vaults"
        onKeyDown={onTreeKey}
        onFocus={(e) => { if (e.target === e.currentTarget) setTreeFocused(true); }}
        onBlur={(e) => { if (e.target === e.currentTarget) setTreeFocused(false); }}
        className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1 outline-none"
        data-tree-focused={treeFocused ? "true" : undefined}
      >
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
          const onHeader = cursor?.id === entity.id && cursor.field === null;
          const hint = entry.search.split(" ").find((s) => s && !s.startsWith("http")) ?? "";
          return (
            <EntityRow
              key={row.id}
              depth={row.depth}
              active={open || onHeader}
              className={`cursor-pointer ${onHeader && treeFocused ? "ring-1 ring-inset ring-[var(--c-accent)]" : ""}`}
              dataAttrs={{ "data-browse-entity": entity.id, "data-vault-entity": entity.name, "data-cursor": onHeader ? "true" : undefined }}
              icon={<Icon size={13} />}
              title={entity.name}
              title_={`${KIND_LABELS[entity.kind]}${entity.path ? ` — ${entity.path}` : ""}`}
              secondary={(hint || entry.tags.length > 0) ? (
                <>
                  {hint && <span className="truncate">{hint}</span>}
                  <EntityTags tags={entry.tags} />
                </>
              ) : undefined}
              onClick={() => { setCursor({ id: entity.id, field: null }); setOpenId(open ? null : entity.id); treeRef.current?.focus(); }}
            >
              {open && (
                <FieldList
                  entry={entry}
                  values={values}
                  revealed={revealed}
                  cursorField={cursor?.id === entity.id ? cursor.field : null}
                  cursorVisible={treeFocused}
                  targetLabel={targetLabel}
                  onReveal={toggleReveal}
                  onCopy={(fv) => copy(entry, fv)}
                  onPaste={(fv, enter) => paste(entry, fv, enter, true)}
                  onPoint={(i) => { setCursor({ id: entity.id, field: i }); treeRef.current?.focus(); }}
                />
              )}
            </EntityRow>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--c-border)] px-3 py-1.5 text-[11.5px] text-[var(--c-text-muted)]">
        {treeFocused ? (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            <span><span className="kbd">↑↓</span> naviguer</span>
            <span><span className="kbd">Entrée</span> coller</span>
            <span><span className="kbd">Maj+Entrée</span> coller puis Entrée</span>
            <span><span className="kbd">Ctrl+C</span> copier</span>
            <span><span className="kbd">Espace</span> afficher</span>
          </span>
        ) : targetLabel ? <>Coller écrit dans <span className="text-[var(--c-text-secondary)]">{targetLabel}</span>.</> : "Aucun terminal actif — seul « Copier » est possible."}
      </div>
    </div>
  );
}

// ─── Les champs d'un item déplié ────────────────────────────────────────────

interface FieldListProps {
  entry: GuiVaultBrowseEntry;
  values: Values;
  revealed: ReadonlySet<string>;
  /** L'index du champ sous le curseur clavier, ou `null`. */
  cursorField: number | null;
  cursorVisible: boolean;
  targetLabel: string | null;
  onReveal: (key: string) => void;
  onCopy: (fv: GuiVaultBrowseValue) => void;
  onPaste: (fv: GuiVaultBrowseValue, enter: boolean) => void;
  onPoint: (index: number) => void;
}

function FieldList({ entry, values, revealed, cursorField, cursorVisible, targetLabel, onReveal, onCopy, onPaste, onPoint }: FieldListProps) {
  if (values.state === "loading") {
    return <p className="px-1 pb-1 text-[11.5px] text-[var(--c-text-muted)]">Lecture…</p>;
  }
  if (values.state === "error") {
    return <p className="px-1 pb-1 text-[11.5px] text-[var(--c-danger)]">{values.message}</p>;
  }
  if (values.values.length === 0) {
    return <p className="px-1 pb-1 text-[11.5px] text-[var(--c-text-muted)]">Rien à copier dans cet item.</p>;
  }
  return (
    <ul className="mb-1 flex flex-col gap-0.5 rounded-md border border-[var(--c-border)] bg-[var(--c-bg)] p-1" data-browse-fields="">
      {values.values.map((fv, i) => {
        const shown = revealed.has(fv.key);
        const onCursor = cursorField === i;
        return (
          <li
            key={fv.key}
            data-browse-field-index={i}
            data-browse-field={fv.key}
            data-cursor={onCursor ? "true" : undefined}
            onClick={(e) => { e.stopPropagation(); onPoint(i); }}
            className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--c-hover)] ${onCursor ? "bg-[var(--c-accent-dim)]" : ""} ${onCursor && cursorVisible ? "ring-1 ring-inset ring-[var(--c-accent)]" : ""}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-[var(--c-text-muted)]">{fv.label}</span>
              {fv.totp ? (
                <TotpValue vaultId={entry.vaultId} id={entry.id} />
              ) : fv.secret && !shown ? (
                <span className="block font-mono text-[12px] text-[var(--c-text-secondary)]" data-browse-value="masked">••••••••</span>
              ) : fv.multiline ? (
                <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11.5px] leading-snug text-[var(--c-text)]" data-browse-value="shown">{fv.value}</pre>
              ) : (
                <span className="block break-all font-mono text-[12px] text-[var(--c-text)]" data-browse-value="shown">{fv.value}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {fv.secret && !fv.totp && (
                <button onClick={(e) => { e.stopPropagation(); onReveal(fv.key); }} tabIndex={-1} title={shown ? `Masquer — ${fv.label}` : `Afficher — ${fv.label}`} aria-label={`${shown ? "Masquer" : "Afficher"} ${fv.label}`} className="btn btn-ghost btn-sm btn-icon">
                  {shown ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              )}
              <button onClick={(e) => { e.stopPropagation(); onCopy(fv); }} tabIndex={-1} title={`Copier — ${fv.label}`} aria-label={`Copier ${fv.label}`} className="btn btn-ghost btn-sm btn-icon">
                <IconCopy size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onPaste(fv, false); }}
                tabIndex={-1}
                disabled={!targetLabel}
                title={targetLabel ? `Coller dans ${targetLabel} — ${fv.label}` : "Aucun terminal actif"}
                aria-label={`Coller ${fv.label}`}
                className="btn btn-ghost btn-sm btn-icon"
              >
                <IconPaste size={13} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onPaste(fv, true); }}
                tabIndex={-1}
                disabled={!targetLabel}
                title={targetLabel ? `Coller puis Entrée dans ${targetLabel} — ${fv.label}` : "Aucun terminal actif"}
                aria-label={`Coller ${fv.label} puis Entrée`}
                className="btn btn-ghost btn-sm btn-icon"
              >
                <IconReturn size={13} />
              </button>
            </span>
          </li>
        );
      })}
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
