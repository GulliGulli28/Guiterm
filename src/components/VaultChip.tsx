/** L'étiquette « ce vault partagé » sur une ligne d'entité — la même partout
 * (hôtes, dossiers, clés, snippets, connexions), pour qu'un vault se
 * reconnaisse d'un panneau à l'autre. */
export function VaultChip({ name }: { name: string | undefined }) {
  if (!name) return null;
  return <span className="tag tag-accent" title={`Vault partagé « ${name} »`}>{name}</span>;
}
