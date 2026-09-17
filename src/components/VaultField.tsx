import type { GuiVaultVault, VaultId } from "../lib/types";

/**
 * Le champ « Vault GuiVault » des formulaires d'hôte, de dossier et de
 * connexion : dans quel vault du compte l'entité est rangée. Le même
 * partout, pour que changer de vault se fasse au même endroit quel que soit
 * le genre d'entité — et parce que le formulaire d'hôte l'avait seul.
 *
 * Absent sans compte affiché (`vaults` vide) : le champ n'a alors aucun sens.
 * En lecture seule (`readOnly`), l'entité ne se déplace pas non plus : la
 * retirer du vault serait une suppression que la synchro annulerait.
 */
export function VaultField({ vaults, value, onChange, readOnly, hint }: {
  vaults: GuiVaultVault[];
  /** `""` = personnel. */
  value: VaultId | "";
  onChange: (next: VaultId | "") => void;
  readOnly?: boolean;
  /** Ce qui suit l'entité dans un vault partagé (« Sa clé du trousseau le suit »). */
  hint: string;
}) {
  const shared = vaults.filter((v) => v.kind === "shared");
  if (shared.length === 0 && value === "") return null;
  return (
    <label className="block">
      <span className="field-label">Vault GuiVault</span>
      <select
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="input w-full"
        title={readOnly ? "Vault en lecture seule : cette entité ne peut être ni modifiée ni déplacée" : `Une entité rangée dans un vault partagé est visible — secrets compris — par tous ses membres. ${hint}`}
        data-vault-field=""
      >
        <option value="">Personnel (vous seul)</option>
        {shared.map((v) => (
          <option key={v.id} value={v.id} disabled={v.role === "reader"}>
            {v.name}{v.role === "reader" ? " (lecture seule)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Le vault d'affiliation actuel, s'il est en lecture seule pour ce compte. */
export function readOnlyVault(vaults: GuiVaultVault[], vaultId: VaultId | null | undefined): GuiVaultVault | null {
  const v = vaults.find((x) => x.id === vaultId);
  return v && v.kind === "shared" && v.role === "reader" ? v : null;
}

/** Le bandeau d'un formulaire dont l'entité est dans un vault lu : tout est
 * grisé derrière (`<fieldset disabled>`), et ceci dit pourquoi. */
export function ReadOnlyVaultNotice({ vault, what }: { vault: GuiVaultVault; what: string }) {
  return (
    <p className="callout callout-warn" data-vault-read-only="">
      Vous êtes lecteur de « {vault.name} » : {what} se consulte mais ne se modifie pas — une modification ne serait pas synchronisée et reviendrait à la synchro suivante. Un éditeur du vault peut le changer, ou vous en donner le rôle.
    </p>
  );
}
