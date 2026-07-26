//! Manual smoke test for `crate::mongo_client` against a *real* MongoDB
//! server — exercises exactly the code path `commands::mongo`/`MongoTab.tsx`
//! drive (`mongo_client::connect` via a plain connection string,
//! `list_databases`, `list_collections`, `find_documents` with no filter and
//! with a JSON filter including extended-JSON `$oid`/`$gt` operators).
//!
//! Requires a reachable MongoDB server, e.g. locally via Docker:
//!   docker run -d -p 27017:27017 mongo:7
//!
//! Usage: `cargo run --example mongo_wsl_smoke -- <connection-string>`
//!   e.g. cargo run --example mongo_wsl_smoke -- mongodb://127.0.0.1:27017
//!
//! Only ever run manually/by hand — never in CI (no MongoDB server there,
//! same as `sql_wsl_smoke`/`redis_wsl_smoke`'s live-server requirements).
use termius_core::model::{EngineConfig, MongoConfig, SqlConnection, Workspace};
use termius_core::mongo_client;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let connection_string = args.next().expect("usage: mongo_wsl_smoke <connection-string>");

    let workspace = Workspace::default();
    let conn = SqlConnection::new(
        "mongo_wsl_smoke (temporary)",
        EngineConfig::Mongodb(MongoConfig { connection_string: connection_string.clone(), ..Default::default() }),
    );

    println!("== connecting to {connection_string}...");
    let session = mongo_client::connect(&workspace, &conn).await?;
    println!("== connected.");
    let handle = session.handle();

    let databases = mongo_client::list_databases(handle.clone()).await?;
    println!("== list_databases (system dbs hidden): {databases:?}");

    for db in &databases {
        let collections = mongo_client::list_collections(handle.clone(), db).await?;
        println!("== list_collections({db:?}): {collections:?}");

        for coll in &collections {
            match mongo_client::find_documents(handle.clone(), db, &coll.name, None).await {
                Ok(result) => println!("== find_documents({db:?}, {:?}, filter=None): {} docs, truncated={}", coll.name, result.documents.len(), result.truncated),
                Err(e) => println!("== find_documents({db:?}, {:?}, filter=None) FAILED: {e:#}", coll.name),
            }
        }
    }

    // A filtered query on shop.users (if present) — exercises both a plain
    // operator ($gt) and, if any user has an ObjectId-typed field to match
    // against, the extended-JSON $oid wrapper on the way in.
    if databases.iter().any(|d| d == "shop") {
        match mongo_client::find_documents(handle.clone(), "shop", "users", Some(r#"{"age": {"$gt": 26}}"#)).await {
            Ok(result) => println!("== find_documents(shop, users, {{age: {{$gt: 26}}}}): {:#?}", result.documents),
            Err(e) => println!("== filtered find_documents FAILED: {e:#}"),
        }

        match mongo_client::find_documents(handle.clone(), "shop", "users", Some("not json")).await {
            Ok(result) => println!("== find_documents with invalid filter unexpectedly succeeded: {result:?}"),
            Err(e) => println!("== find_documents with invalid filter correctly failed: {e:#}"),
        }
    }

    session.close().await?;
    println!("== done.");
    Ok(())
}
