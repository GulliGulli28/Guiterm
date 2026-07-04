import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { CustomIcon, Workspace } from "../lib/types";
import { BUILTIN_ICONS, CATEGORY_LABELS, type BuiltinIconDef } from "./icons";

// NOTE: onClose is ONLY for click-outside dismissal.
// Icon selection buttons call onSelect only — onSelect is responsible for closing the picker.

interface IconPickerProps {
  value: string | null;
  customIcons: CustomIcon[];
  onSelect: (iconId: string | null) => void;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onClose: () => void;
}

type Tab = "builtin" | "custom";
type Category = BuiltinIconDef["category"];

export function IconPicker({ value, customIcons, onSelect, onWorkspaceUpdate, onClose }: IconPickerProps) {
  const [tab, setTab] = useState<Tab>("builtin");
  const [category, setCategory] = useState<Category>("linux");
  const [importing, setImporting] = useState(false);
  const [importName, setImportName] = useState("");
  const [importDataUrl, setImportDataUrl] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const startImport = async () => {
    const selected = await open({
      title: "Choisir une image",
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const dataUrl = await api.readIconFile(selected);
      const fileName = selected.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Icône";
      setImportDataUrl(dataUrl);
      setImportName(fileName);
      setImporting(true);
      setImportError(null);
      setTab("custom");
    } catch (e) {
      setImportError(String(e));
    }
  };

  const confirmImport = async () => {
    if (!importDataUrl || !importName.trim()) return;
    try {
      const ws = await api.addCustomIcon(importName.trim(), importDataUrl);
      onWorkspaceUpdate(ws);
      const added = ws.customIcons.find((i) => i.dataUrl === importDataUrl);
      if (added) onSelect(added.id);
      setImporting(false);
      setImportDataUrl(null);
    } catch (e) {
      setImportError(String(e));
    }
  };

  const filteredBuiltin = BUILTIN_ICONS.filter((i) => i.category === category);

  const btnClass = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium transition-colors ${active ? "bg-[var(--c-accent)] text-white" : "text-[var(--c-text-secondary)] hover:bg-white/5 hover:text-[var(--c-text)]"}`;

  return (
    <div
      ref={ref}
      className="absolute z-50 mt-1 w-72 rounded-xl bg-[var(--c-bg2)] p-3 shadow-[var(--shadow-lg)]"
    >
      {/* Tab row */}
      <div className="mb-2.5 flex items-center gap-1">
        <button onClick={() => setTab("builtin")} className={btnClass(tab === "builtin")}>
          Banque
        </button>
        <button onClick={() => setTab("custom")} className={btnClass(tab === "custom")}>
          Mes icônes
        </button>
        {value && (
          <button
            onClick={() => { onSelect(null); onClose(); }}
            className="ml-auto rounded px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-900/30"
          >
            ✕ Retirer
          </button>
        )}
      </div>

      {/* Built-in tab */}
      {tab === "builtin" && (
        <>
          <div className="mb-2 flex gap-1">
            {(["linux", "system", "generic"] as Category[]).map((c) => (
              <button key={c} onClick={() => setCategory(c)} className={btnClass(category === c)}>
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-5 gap-1">
            {filteredBuiltin.map((icon) => (
              <button
                key={icon.id}
                onClick={() => onSelect(icon.id)}
                title={icon.name}
                className={`flex flex-col items-center gap-0.5 rounded p-1.5 transition-colors ${
                  value === icon.id
                    ? "ring-2 ring-[var(--c-accent-text)] bg-[var(--c-accent-dim)]"
                    : "hover:bg-white/5"
                }`}
              >
                {icon.render(28)}
                <span className="w-full truncate text-center text-[9px] leading-tight text-[var(--c-text-secondary)]">
                  {icon.name}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Custom tab */}
      {tab === "custom" && (
        <>
          {importError && (
            <p className="mb-2 rounded bg-rose-950 px-2 py-1 text-xs text-rose-300">{importError}</p>
          )}

          {importing && importDataUrl ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <img src={importDataUrl} width={40} height={40} className="rounded bg-[var(--c-bg3)] object-contain" alt="" />
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="Nom de l'icône"
                  className="flex-1 rounded-md bg-[var(--c-bg3)] px-2 py-1.5 text-sm text-[var(--c-text)] placeholder:text-[var(--c-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--c-accent-hover)]"
                />
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={confirmImport}
                  className="flex-1 rounded-md bg-[var(--c-accent)] py-1.5 text-xs font-medium text-white hover:bg-[var(--c-accent-hover)]"
                >
                  Enregistrer
                </button>
                <button
                  onClick={() => { setImporting(false); setImportDataUrl(null); }}
                  className="rounded-md bg-[var(--c-bg3)] px-3 py-1.5 text-xs text-[var(--c-text-secondary)] hover:bg-white/5"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <>
              {customIcons.length === 0 && !importing && (
                <p className="py-3 text-center text-xs text-[var(--c-text-muted)]">Aucune icône personnalisée</p>
              )}
              <div className="grid grid-cols-5 gap-1">
                {customIcons.map((icon) => (
                  <button
                    key={icon.id}
                    onClick={() => onSelect(icon.id)}
                    title={icon.name}
                    className={`flex flex-col items-center gap-0.5 rounded p-1.5 transition-colors ${
                      value === icon.id
                        ? "ring-2 ring-[var(--c-accent-text)] bg-[var(--c-accent-dim)]"
                        : "hover:bg-white/5"
                    }`}
                  >
                    <img src={icon.dataUrl} width={28} height={28} className="rounded object-contain" alt={icon.name} />
                    <span className="w-full truncate text-center text-[9px] leading-tight text-[var(--c-text-secondary)]">
                      {icon.name}
                    </span>
                  </button>
                ))}
              </div>
              <button
                onClick={startImport}
                className="mt-2 w-full rounded-md border border-dashed border-[var(--c-border)] py-1.5 text-xs text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]"
              >
                + Importer une icône
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
