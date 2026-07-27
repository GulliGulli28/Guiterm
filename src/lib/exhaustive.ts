/** Compile-time guard that a discriminated union has been handled completely.
 *
 * Call it from the `default` branch of a `switch` over a union's tag. As long
 * as every variant is handled, the value reaching `default` is `never` and
 * this compiles. Add a variant to the union without adding its branch and the
 * argument is no longer `never`, so **`tsc` fails** — the missing case becomes
 * a build error instead of silently falling through to whatever the last
 * `else` happened to be.
 *
 * This exists because that exact silent fallthrough shipped: `App.tsx`
 * rendered `connection.engine === "redis" ? <RedisTab/> : <SqlTab/>`, so
 * adding the `mongodb` engine sent MongoDB connections into the SQL tab, which
 * fails at connect time. Nothing caught it — not `tsc`, not clippy, not 218
 * Rust tests, not the E2E — because a missing branch of a ternary is a hole
 * for none of them. See `docs/dev-history.md`, "MongoDB : backend livré,
 * onglet frontend jamais écrit".
 *
 * The thrown error is a genuine last resort: it can only be reached if
 * something bypassed the type system (unvalidated JSON from the backend, a
 * cast), which is why it names the value rather than failing silently.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context} : cas non géré — ${JSON.stringify(value)}`);
}
