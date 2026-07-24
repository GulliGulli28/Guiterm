//! Manual smoke test for `crate::redis_client` against a *real* Redis server
//! — exercises exactly the code path `commands::redis`/`RedisTab.tsx` drive
//! (`redis_client::connect`, `scan_keys` with and without a search pattern,
//! `get_value` for every type it renders structurally, `run_command` for a
//! read, a write, and a deliberately invalid command).
//!
//! Requires a reachable Redis server, e.g. locally via Docker:
//!   docker run -d -p 16379:6379 redis:7-alpine
//!
//! Usage: `cargo run --example redis_wsl_smoke -- <host> <port>`
//!
//! Only ever run manually/by hand — never in CI (no Redis server there, same
//! as `sql_wsl_smoke`'s PostgreSQL/SSH-host requirement).
use termius_core::model::{SqlConnection, SqlEngine, Workspace};
use termius_core::redis_client;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let host = args.next().expect("usage: redis_wsl_smoke <host> <port>");
    let port: u16 = args.next().expect("missing <port>").parse()?;

    let workspace = Workspace::default();
    let mut conn = SqlConnection::new("redis_wsl_smoke (temporary)", SqlEngine::Redis, &host, "");
    conn.port = port;

    println!("== connecting to {host}:{port}...");
    let session = redis_client::connect(&workspace, &conn).await?;
    println!("== connected. database = {}", session.database);
    let handle = session.handle();

    let page = redis_client::scan_keys(handle.clone(), 0, None).await?;
    println!("== scan_keys(pattern=None): {} keys, cursor={}", page.keys.len(), page.cursor);
    for entry in &page.keys {
        println!("==   {} ({}, ttl={:?})", entry.key, entry.key_type, entry.ttl_secs);
    }

    for entry in &page.keys {
        match redis_client::get_value(handle.clone(), &entry.key).await {
            Ok(Some(detail)) => println!("== get_value({:?}) = {:?}", entry.key, detail),
            Ok(None) => println!("== get_value({:?}) = <disparue>", entry.key),
            Err(e) => println!("== get_value({:?}) FAILED: {e:#}", entry.key),
        }
    }

    let filtered = redis_client::scan_keys(handle.clone(), 0, Some("user")).await?;
    println!(
        "== scan_keys(pattern=\"user\") -> substring match: {:?}",
        filtered.keys.iter().map(|k| &k.key).collect::<Vec<_>>()
    );

    for command in ["GET greeting", "SET smoke:test hello", "GET smoke:test", "NOTACOMMAND foo", "TYPE mylist"] {
        match redis_client::run_command(handle.clone(), command).await {
            Ok(reply) => println!("== run_command({command:?}) = {reply:?}"),
            Err(e) => println!("== run_command({command:?}) FAILED: {e:#}"),
        }
    }
    let _ = redis_client::run_command(handle.clone(), "DEL smoke:test").await;

    session.close().await?;
    println!("== done.");
    Ok(())
}
