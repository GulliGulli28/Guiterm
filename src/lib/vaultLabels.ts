import type { GuiVaultStatus, Workspace } from "./types";

/** Entité (par id) → nom de son vault GuiVault partagé, pour l'étiqueter.
 *
 * Vide sans compte, ou quand le profil local est affiché : ce qu'on voit
 * alors n'a aucune affiliation. Le vault personnel n'est pas étiqueté — c'est
 * l'absence d'étiquette. */
export function vaultNameMap(workspace: Workspace, status: GuiVaultStatus | null): Map<string, string> {
  const names = new Map<string, string>();
  if (!status || !status.configured || status.viewLocal) return names;
  const byId = new Map(status.vaults.filter((v) => v.kind === "shared").map((v) => [v.id, v.name]));
  for (const [id, vaultId] of Object.entries(workspace.vaultBindings ?? {})) {
    const name = byId.get(vaultId);
    if (name) names.set(id, name);
  }
  return names;
}
