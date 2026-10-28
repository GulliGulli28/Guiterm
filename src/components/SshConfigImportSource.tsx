import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { GroupId, Host, SshConfigHost, Workspace } from "../lib/types";
import { GroupTreePicker } from "./GroupTreePicker";
import { ImportSourceFrame } from "./ImportSourceFrame";
import { IconSearch } from "./ui-icons";

/** Un hôte de `~/.ssh/config` qu'on a déjà : même adresse, même utilisateur,
 * même port. L'alias ne compte pas — on renomme souvent un hôte importé. */
export function alreadyImported(entry: SshConfigHost, hosts: Host[]): boolean {
  const address = (entry.hostname ?? entry.alias).toLowerCase();
  const port = entry.port ?? 22;
  return hosts.some((h) =>
    h.address.toLowerCase() === address && h.port === port && (entry.user == null || h.username === entry.user));
}

/**
 * La source `~/.ssh/config` de la fenêtre d'import. Rien n'est écrit avant
 * « Importer ».
 *
 * Le fichier est lu une fois par la fenêtre (`found`), qui en a besoin pour la
 * ligne d'état de la colonne de gauche ; la source ne le relit pas.
 *
 * Les hôtes déjà présents sont décochés d'office : les réimporter créerait des
 * doublons que l'utilisateur devrait ensuite trier à la main.
 */
export function SshConfigImportSource({ workspace, found, onWorkspaceUpdate, onError, onClose }: {
  workspace: Workspace;
  /** Le contenu de `~/.ssh/config`, `null` pendant la lecture. */
  found: SshConfigHost[] | null;
  onWorkspaceUpdate: (ws: Workspace) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  // Les hôtes connus à l'ouverture : relire `workspace.hosts` à chaque rendu
  // décocherait sous les yeux de l'utilisateur ce qu'il vient de cocher, dès
  // qu'une synchro arrive.
  const [knownAtOpen] = useState(workspace.hosts);
  const present = useMemo(
    () => new Set((found ?? []).filter((h) => alreadyImported(h, knownAtOpen)).map((h) => h.alias)),
    [found, knownAtOpen],
  );
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Coché d'office : tout ce qui n'est pas déjà là. Calculé au premier rendu
  // où le fichier est lu, puis laissé à l'utilisateur.
  const ticked = selected ?? new Set((found ?? []).filter((h) => !present.has(h.alias)).map((h) => h.alias));
  const [filter, setFilter] = useState("");
  const [groupId, setGroupId] = useState<GroupId | null>(null);
  const [importing, setImporting] = useState(false);

  const shown = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (found ?? []).filter((h) => {
      const text = [h.alias, h.hostname, h.user, h.proxyJump].filter(Boolean).join(" ").toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }, [found, filter]);

  const toggle = (alias: string) => {
    const next = new Set(ticked);
    if (next.has(alias)) next.delete(alias);
    else next.add(alias);
    setSelected(next);
  };
  const selectable = shown.filter((h) => !present.has(h.alias));
  const allShownTicked = selectable.length > 0 && selectable.every((h) => ticked.has(h.alias));
  const toggleShown = () => {
    const next = new Set(ticked);
    for (const h of selectable) {
      if (allShownTicked) next.delete(h.alias);
      else next.add(h.alias);
    }
    setSelected(next);
  };

  const runImport = () => {
    if (!found) return;
    const selections = found
      .filter((h) => ticked.has(h.alias))
      .map((h) => ({
        alias: h.alias,
        hostname: h.hostname ?? h.alias,
        user: h.user ?? "",
        port: h.port ?? 22,
        groupId,
        // Without this an SSM/IAP-only entry would import as a plain direct
        // connection and simply time out — the config file already knew how
        // to reach it.
        proxyCommand: h.proxyCommand,
      }));
    if (selections.length === 0) return;
    setImporting(true);
    api.importSshConfigHosts(selections)
      .then((ws) => { onWorkspaceUpdate(ws); onClose(); })
      .catch((e) => onError(String(e)))
      .finally(() => setImporting(false));
  };

  const total = found?.length ?? 0;

  return (
    <ImportSourceFrame source="sshConfig">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--c-border)] px-4 py-2.5">
        <input
          type="checkbox"
          aria-label="Tout cocher"
          checked={allShownTicked}
          disabled={selectable.length === 0}
          onChange={toggleShown}
          className="h-3.5 w-3.5 shrink-0"
        />
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text)]">
          {found === null ? "Lecture du fichier…" : (
            <>
              <strong className="font-semibold">{ticked.size} sur {total}</strong>
              {present.size > 0 && <span className="text-[var(--c-text-muted)]"> · {present.size} déjà présent{present.size > 1 ? "s" : ""}, ignoré{present.size > 1 ? "s" : ""}</span>}
            </>
          )}
        </p>
        <label className="relative w-56">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[var(--c-text-muted)]"><IconSearch size={12} /></span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer" aria-label="Filtrer" className="input pl-7" />
        </label>
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto">
        {found?.length === 0 && (
          <p className="px-4 py-10 text-center text-[12.5px] text-[var(--c-text-muted)]">Aucun hôte trouvé dans ~/.ssh/config.</p>
        )}
        {total > 0 && (
          <table className="w-full table-fixed text-[12.5px]" data-ssh-config-import="">
            <thead>
              <tr className="text-left text-[11px] text-[var(--c-text-muted)]">
                <th className="w-9 px-4 py-2 font-medium" />
                <th className="px-2 py-2 font-medium">Alias</th>
                <th className="px-2 py-2 font-medium">Adresse</th>
                <th className="w-[18%] px-2 py-2 font-medium">Utilisateur</th>
                <th className="w-[16%] px-2 py-2 font-medium">Passe par</th>
                <th className="w-32 px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {shown.map((h) => {
                const known = present.has(h.alias);
                return (
                  <tr key={h.alias} data-alias={h.alias} className={`border-t border-[var(--c-border)] ${known ? "opacity-55" : ""}`}>
                    <td className="px-4 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Importer ${h.alias}`}
                        checked={ticked.has(h.alias)}
                        onChange={() => toggle(h.alias)}
                        className="h-3.5 w-3.5"
                      />
                    </td>
                    <td className="truncate px-2 py-1.5 font-medium text-[var(--c-text)]">{h.alias}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11.5px] text-[var(--c-text-muted)]">{h.hostname ?? h.alias}{h.port && h.port !== 22 ? `:${h.port}` : ""}</td>
                    <td className="truncate px-2 py-1.5 font-mono text-[11.5px] text-[var(--c-text-muted)]">{h.user ?? "—"}</td>
                    <td className="truncate px-2 py-1.5 text-[var(--c-text-secondary)]" title={h.proxyCommand ?? undefined}>
                      {h.proxyJump ?? (h.proxyCommand ? "commande proxy" : <span className="text-[var(--c-text-faint)]">—</span>)}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {known ? <span className="chip">Déjà présent</span> : <span className="chip chip-ok">Nouveau</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {total > 0 && shown.length === 0 && (
          <p className="px-4 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">Aucun hôte ne correspond à « {filter} ».</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-4 py-2.5">
        <span className="text-[11.5px] text-[var(--c-text-muted)]">Ranger dans</span>
        <div className="w-64">
          <GroupTreePicker
            groups={workspace.groups}
            value={groupId}
            onChange={setGroupId}
            customIcons={workspace.customIcons ?? []}
          />
        </div>
        <span className="flex-1" />
        <button onClick={runImport} disabled={importing || ticked.size === 0} className="btn btn-primary">
          {importing ? "Import…" : ticked.size > 0 ? `Importer ${ticked.size} hôte${ticked.size > 1 ? "s" : ""}` : "Importer"}
        </button>
      </div>
    </ImportSourceFrame>
  );
}
