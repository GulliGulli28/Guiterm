//! Manual smoke test for `crate::sql` against a *real* PostgreSQL server —
//! exercises exactly the code path `commands::sql`/`SqlTab.tsx` drive
//! (`sql::connect` through an SSH tunnel, then `list_schemas`/`list_tables`/
//! `list_columns`/`execute_query`), the thing this module's own doc comment
//! flags as never having been run against a real server.
//!
//! Requires, on this dev machine specifically:
//! - A saved SSH host in the real `workspace.json` whose label is given as
//!   argv[1] (password auth reads the real secret from the OS keychain via
//!   `vault::load`, exactly like the app does — this example never sees it).
//! - A PostgreSQL server reachable from *that host* at `127.0.0.1:5432`
//!   (i.e. running on the SSH host itself), with a `postgres` role whose
//!   password is given as argv[2], and a database named by argv[3] — pass
//!   `-` instead to leave the connection's database unset and exercise the
//!   "no database configured" flow instead (`list_databases`/`open_database`,
//!   picking the first database returned).
//!
//! Usage: `cargo run --example sql_wsl_smoke -- <ssh-host-label> <pg-password> <database|->`
//!
//! Only ever run manually/by hand on a machine with this setup — never in CI.

use termius_core::model::SqlConnection;
use termius_core::vault::{self, SecretKind};
use termius_core::{sql, store};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let host_label = args.next().expect("usage: sql_wsl_smoke <ssh-host-label> <pg-password> <database|->");
    let pg_password = args.next().expect("missing <pg-password>");
    let database = args.next().expect("missing <database|->");

    let workspace = store::load()?;
    let host = workspace.hosts.iter().find(|h| h.label == host_label).unwrap_or_else(|| panic!("no host labeled {host_label:?} in workspace.json"));
    println!("== tunnelling through host: {} ({})", host.label, host.id);

    let mut conn = SqlConnection::new("sql_wsl_smoke (temporary)", termius_core::model::SqlEngine::Postgres, "127.0.0.1", "postgres");
    conn.tunnel_host_id = Some(host.id);
    conn.port = 5432;
    conn.database = (database != "-").then_some(database);
    vault::store(conn.id, SecretKind::SqlPassword, &pg_password)?;

    let result = run(&workspace, &conn).await;

    let _ = vault::delete(conn.id, SecretKind::SqlPassword);
    result
}

async fn run(workspace: &termius_core::model::Workspace, conn: &SqlConnection) -> anyhow::Result<()> {
    println!("== connecting (tunnel + postgres handshake)...");
    let mut session = sql::connect(workspace, conn).await?;
    println!("== connected. database = {:?}", session.database);

    if session.database.is_none() {
        let dbs = sql::list_databases(&session.pool).await?;
        println!("== databases: {dbs:?}");
        let pick = dbs.first().expect("no databases returned").clone();
        println!("== switching to database {pick:?} (reusing the same tunnel)...");
        let new_pool = sql::open_database(&session.dial(), &pick).await?;
        let old_pool = session.replace_pool(new_pool, pick);
        old_pool.close().await;
        println!("== switched. database = {:?}", session.database);
    }

    let schemas = sql::list_schemas(&session.pool).await?;
    println!("== schemas: {schemas:?}");

    for schema in &schemas {
        let tables = sql::list_tables(&session.pool, schema).await?;
        println!("== tables in {schema}: {tables:?}");
        for table in &tables {
            let columns = sql::list_columns(&session.pool, schema, &table.name).await?;
            println!("==   columns of {schema}.{}: {columns:?}", table.name);

            let query = format!("SELECT * FROM {schema}.{} LIMIT 5", table.name);
            match sql::execute_query(&session.pool, &query).await {
                Ok(rows) => println!("==   SELECT * FROM {schema}.{}: {rows:?}", table.name),
                Err(e) => println!("==   SELECT * FROM {schema}.{} FAILED: {e:#}", table.name),
            }
        }
    }

    session.close().await;
    Ok(())
}
