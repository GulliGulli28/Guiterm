import { lazy } from "react";
import { assertNever } from "../lib/exhaustive";
import type { SqlConnection, Workspace } from "../lib/types";

// Lazy for the same reason the other large panels are (see `App.tsx`): these
// are among the biggest components in the app and most sessions never open a
// database connection at all. Exported so `SqlConnectionTab.test.ts` can
// assert *which* one a given engine dispatches to by identity, without
// mounting any of them (mounting would immediately `invoke(...)` against a
// Tauri bridge that doesn't exist under vitest).
export const SqlTabLazy = lazy(() => import("./SqlTab").then((m) => ({ default: m.SqlTab })));
export const RedisTabLazy = lazy(() => import("./RedisTab").then((m) => ({ default: m.RedisTab })));
export const MongoTabLazy = lazy(() => import("./MongoTab").then((m) => ({ default: m.MongoTab })));

/** Which component renders a saved database connection, decided exhaustively
 * by engine.
 *
 * A `switch` closed by `assertNever` rather than the ternary this replaces:
 * that ternary was `engine === "redis" ? <RedisTab/> : <SqlTab/>`, so adding
 * the `mongodb` engine silently routed MongoDB connections into the SQL tab,
 * which then failed at connect time with a message blaming the server. Adding
 * a variant to `SqlEngineConfig` without deciding how it renders is now a
 * `tsc` failure instead — see `lib/exhaustive.ts`.
 *
 * Lives in its own module rather than inside `App.tsx` so the dispatch can be
 * unit-tested without importing the whole application graph. */
export function SqlConnectionTab({
  connection,
  workspace,
  onError,
}: {
  connection: SqlConnection;
  workspace: Workspace;
  onError: (message: string) => void;
}) {
  switch (connection.engine) {
    case "mysql":
    case "postgres":
    case "sqlite":
      return <SqlTabLazy connection={connection} workspace={workspace} onError={onError} />;
    case "redis":
      return <RedisTabLazy connection={connection} onError={onError} />;
    case "mongodb":
      return <MongoTabLazy connection={connection} onError={onError} />;
    default:
      return assertNever(connection, "moteur de connexion base de données");
  }
}
