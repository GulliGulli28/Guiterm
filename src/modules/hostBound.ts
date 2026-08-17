import type { Host, HostId } from "../lib/types";
import type { AppContext } from "./types";

/** L'hôte que vise un onglet lié à un hôte.
 *
 * `undefined` quand il a été supprimé pendant que l'onglet était ouvert : les
 * trois modules concernés rendent alors `null`, comme `App.tsx` le faisait.
 * Factorisé parce que c'est la seule chose que `terminal`, `transfer` et `rdp`
 * ont réellement en commun — leurs props n'ont sinon presque rien à voir. */
export function hostOf(ctx: AppContext, hostId: HostId): Host | undefined {
  return ctx.workspace.hosts.find((h) => h.id === hostId);
}
