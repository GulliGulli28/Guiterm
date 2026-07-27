import { sqlEngineLabel } from "../lib/types";
import type { SqlEngine } from "../lib/types";

/** Shown when a connection's engine is saved and supported by the backend but
 * has no browsing UI yet.
 *
 * Currently only MongoDB: `core/src/mongo_client.rs` and `commands/mongo.rs`
 * are complete and exercised by `core/examples/mongo_wsl_smoke.rs`, but
 * `MongoTab` was never written. Before this component existed, `App.tsx` fell
 * through to `SqlTab`, which called `sql::connect` and reported "impossible de
 * se connecter" — blaming the server for a missing screen.
 *
 * Delete this file when `MongoTab` lands: the `mongodb` branch in `App.tsx`
 * switches to it, and `assertNever` keeps the dispatch honest either way. */
export function UnavailableEngineTab({ engine }: { engine: SqlEngine }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-[var(--c-text)]">
        {sqlEngineLabel(engine)} n'est pas encore navigable depuis l'interface
      </p>
      <p className="max-w-md text-xs leading-relaxed text-[var(--c-text-faint)]">
        La connexion est bien enregistrée et le moteur est pris en charge côté
        application, mais l'écran qui permet de parcourir ses données reste à
        écrire. Rien n'est perdu : la connexion s'ouvrira telle quelle dès que
        cet écran existera.
      </p>
    </div>
  );
}
