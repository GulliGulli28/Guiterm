import type { GuiVaultStatus, VaultId, VaultKind, VaultRole } from "./types";

/**
 * Les vaults d'un compte affiché, comme dossiers de premier niveau des
 * panneaux d'entités (Hôtes, Clés, Snippets, Bases de données).
 *
 * Une entité d'un compte GuiVault vit dans exactement un vault : le
 * personnel (aucune affiliation dans `Workspace.vaultBindings`) ou un vault
 * partagé. Plutôt qu'une étiquette sur chaque ligne — qui se lisait après le
 * nom, et ne disait rien du personnel — chaque panneau range ses entités sous
 * un **dossier de vault** repliable : Personnel d'abord, puis chaque vault
 * partagé dans l'ordre du compte. Le même dessin partout, et le même que le
 * panneau GuiVault, pour qu'un vault se reconnaisse d'un panneau à l'autre.
 *
 * `null` sans compte affiché (déconnecté, ou profil local à l'écran) : ce
 * qu'on voit alors n'a aucune affiliation, et les panneaux restent à plat.
 */
export interface VaultSection {
  /** `null` = le vault personnel. */
  id: VaultId | null;
  name: string;
  kind: VaultKind;
  role: VaultRole;
}

export const PERSONAL_SECTION_NAME = "Personnel";

export function vaultSections(status: GuiVaultStatus | null | undefined): VaultSection[] | null {
  if (!status || !status.configured || !status.unlocked || status.viewLocal) return null;
  const shared = status.vaults.filter((v) => v.kind === "shared").map((v) => ({ id: v.id, name: v.name, kind: v.kind, role: v.role }));
  return [{ id: null, name: PERSONAL_SECTION_NAME, kind: "personal", role: "owner" }, ...shared];
}

/** Le rôle d'une section, en un mot, quand il limite ce qu'on peut y faire. */
export function sectionRoleLabel(section: VaultSection): string | null {
  if (section.kind === "personal") return null;
  return section.role === "reader" ? "lecture seule" : null;
}

export interface VaultBucket<T> {
  section: VaultSection;
  items: T[];
}

/**
 * Répartit des entités par vault, dans l'ordre des sections. Une entité
 * affiliée à un vault que le compte ne liste plus (accès retiré, la synchro
 * suivante la retirera) est rangée dans une section « inaccessible » plutôt
 * que glissée dans le personnel : la montrer là serait un mensonge, la
 * cacher ferait croire qu'elle est perdue.
 */
export function splitByVault<T extends { id: string }>(
  items: readonly T[],
  bindings: Record<string, VaultId> | undefined,
  sections: readonly VaultSection[],
): VaultBucket<T>[] {
  const buckets = new Map<VaultId | null, VaultBucket<T>>();
  for (const section of sections) buckets.set(section.id, { section, items: [] });
  for (const item of items) {
    const vaultId = bindings?.[item.id] ?? null;
    let bucket = buckets.get(vaultId);
    if (!bucket) {
      bucket = { section: { id: vaultId, name: "Vault inaccessible", kind: "shared", role: "reader" }, items: [] };
      buckets.set(vaultId, bucket);
    }
    bucket.items.push(item);
  }
  return [...buckets.values()];
}
