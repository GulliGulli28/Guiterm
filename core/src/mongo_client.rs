//! MongoDB client — connects via a full connection string (`mongodb://` or
//! `mongodb+srv://`, e.g. pasted from Atlas), rather than the discrete
//! `address`/`port` fields MySQL/PostgreSQL/Redis share (see
//! [`crate::model::SqlConnection::connection_string`]'s doc comment for why
//! MongoDB doesn't fit that shape), browses databases/collections, and runs
//! a JSON filter as a bounded `find()`.
//!
//! Named `mongo_client` (not `mongo`) for the same reason `core::sql` isn't
//! named `sqlx` and `crate::redis_client` isn't named `redis` — avoids
//! `use mongodb::...` inside this module ever needing `crate::`/`self::`
//! disambiguation against the crate of the same name. Lives in `core/`
//! directly, like `sql`/`redis_client`, rather than a separate sidecar
//! process: the `mongodb` driver crate resolves cleanly against this
//! workspace's existing dependency graph — verified via `cargo build` (single
//! resolved version of `chrono`/`rustls`/`time`/`hickory-resolver` throughout,
//! no exact-pin conflict like `ironrdp-connector`'s `picky` had, see
//! CLAUDE.md's "Pourquoi un processus RDP séparé") — see `core/Cargo.toml`'s
//! comment on the `mongodb`/`bson` lines for the feature-flag details
//! (`bson-3`/`compat-3-3-0` are mandatory, not optional, with
//! `default-features = false`; a *direct* `bson` dependency line was needed
//! too, purely to unify in `serde_json-1` — `mongodb`'s own internal `bson`
//! dependency doesn't enable it, but Cargo unifies features across every
//! requester of the same resolved package).
//!
//! **Deliberately not a `core::sql::SqlPool`/`SqlEngine` case** — same
//! reasoning as `redis_client`: a document store has no fixed schema/table
//! tree or SQL query language, so the frontend renders a MongoDB connection
//! through `MongoTab`, a different component from `SqlTab`, not a branch
//! inside it.
//!
//! **No "Structure" tab, no "Console" tab** — deliberate scope choices, not
//! oversights. Schema-inference-by-sampling (à la MongoDB Compass) is out of
//! scope for a first version — "Données"/"Requête" show real documents
//! (pretty-printed JSON) instead of an inferred/approximate schema, which is
//! both simpler to build and arguably more honest for a schemaless store. A
//! raw command console (mirroring Redis's) isn't offered either: unlike a
//! bounded set of Redis commands, a MongoDB shell console is effectively a
//! JS-expression evaluator — a much bigger surface than this first version
//! takes on. [`find_documents`] is read-only (`find()`+filter only — no
//! update/delete/aggregation pipeline yet), the one function behind both the
//! "Données" tab (empty filter) and the "Requête" tab (user-typed filter),
//! exactly like `core::sql::execute_query` backs both SQL's "Data" and
//! "Query" tabs.
use crate::db_tunnel::{self, OpenTunnel};
use crate::model::{EngineConfig, SqlConnection, Workspace};
use crate::vault::{self, SecretKind};
use bson::{Bson, Document};
use futures_util::TryStreamExt;
use serde::Serialize;

/// The live client behind a [`MongoSession`] — deliberately opaque (wraps
/// `mongodb::Client` privately) so `commands::mongo` in `src-tauri` never
/// needs a direct dependency on the `mongodb` crate, only on this type —
/// same invariant `core::sql::SqlPool`/`core::redis_client::RedisHandle`
/// already keep for `sqlx`/`redis`. Cheap to `Clone` (the driver's `Client`
/// is `Arc`-based internally, built to be shared across concurrent
/// callers).
#[derive(Clone)]
pub struct MongoHandle(mongodb::Client);

/// A live MongoDB connection: the client, plus — when tunnelled — whatever's
/// needed to keep that alive for as long as the client is. Dropping this
/// without calling [`close`](MongoSession::close) first leaves the tunnel's
/// accept loop running detached, exactly the same caveat
/// `core::sql::SqlSession`/`core::redis_client::RedisSession` already
/// document for their own tunnel field. No explicit client-side shutdown
/// call is needed beyond that — unlike a `sqlx` pool, a plain `mongodb::Client`
/// has no `close()`/`shutdown()` of its own to await; dropping it is enough.
pub struct MongoSession {
    client: mongodb::Client,
    tunnel: OpenTunnel,
}

impl MongoSession {
    pub fn handle(&self) -> MongoHandle {
        MongoHandle(self.client.clone())
    }

    pub async fn close(self) -> anyhow::Result<()> {
        db_tunnel::close(self.tunnel).await;
        Ok(())
    }
}

/// Injects `username`/`password` into `url`'s userinfo, in place, if
/// `username` is non-empty and the URL doesn't already carry credentials —
/// mirrors `core::sql::build_url`'s safe-percent-encoding-via-setters
/// approach rather than string-splicing. A no-op otherwise (either no
/// username configured, or the connection string already embeds its own).
fn inject_credentials(url: &mut url::Url, username: &str, password: Option<&str>) {
    if username.is_empty() || !url.username().is_empty() {
        return;
    }
    let _ = url.set_username(username);
    let _ = url.set_password(password.filter(|p| !p.is_empty()));
}

/// Connects `conn` — directly, or (when `tunnel_host_id` is set) via an
/// ephemeral SSH local port forward through that saved host first, exactly
/// like `core::sql::connect`/`core::redis_client::connect` (never persisted
/// / never visible in the Tunnels panel).
///
/// The tunnel path requires `connection_string` to be a plain single-host
/// `mongodb://host:port/...` URI — rejected outright for `mongodb+srv://` or
/// a comma-joined multi-host string, since neither can be transparently
/// tunnelled through one TCP forward (SRV does its own multi-host discovery;
/// a replica set's driver-side failover assumes it can reach every member
/// directly). The direct (no-tunnel) path has no such restriction — a
/// `mongodb+srv://` string is expected to be the common case there.
pub async fn connect(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<MongoSession> {
    let EngineConfig::Mongodb(mongo) = &conn.config else {
        anyhow::bail!("mongo_client::connect ne s'applique qu'aux connexions MongoDB");
    };
    if mongo.connection_string.is_empty() {
        anyhow::bail!("chaîne de connexion MongoDB manquante");
    }
    let raw_uri = mongo.connection_string.clone();
    let password = vault::load(conn.id, SecretKind::SqlPassword)?;

    let (uri, tunnel) = if mongo.tunnel.is_direct() {
        match url::Url::parse(&raw_uri) {
            Ok(mut url) => {
                inject_credentials(&mut url, &mongo.username, password.as_deref());
                (url.to_string(), OpenTunnel::None)
            }
            // Doesn't parse as a standard URL — most likely a comma-joined
            // multi-host string (the one shape this doesn't accept, see this
            // module's doc comment). Used as-is only if there's no
            // credential to inject; otherwise there's no safe place to put
            // it without risking corrupting a string we can't parse.
            Err(_) if mongo.username.is_empty() => (raw_uri, OpenTunnel::None),
            Err(_) => anyhow::bail!(
                "impossible d'insérer les identifiants dans cette chaîne de connexion (format non reconnu) — inclure le nom d'utilisateur et le mot de passe directement dedans"
            ),
        }
    } else {
        // The single-host restriction is a property of forwarding one TCP
        // port, not of SSH — so it applies to an SSM tunnel identically, and
        // the message says "tunnel" rather than naming a mechanism.
        let mut url = url::Url::parse(&raw_uri)
            .map_err(|_| anyhow::anyhow!("tunnel : une chaîne de connexion mono-hôte est attendue (mongodb://hôte:port/...)"))?;
        if url.scheme() != "mongodb" {
            anyhow::bail!("un tunnel ne s'applique qu'aux chaînes mongodb:// mono-hôte, pas mongodb+srv:// ni une liste d'hôtes");
        }
        let dest_host = url.host_str().ok_or_else(|| anyhow::anyhow!("hôte manquant dans la chaîne de connexion"))?.to_string();
        let dest_port = url.port().unwrap_or(27017);

        let dialled = db_tunnel::open(workspace, &mongo.tunnel, &dest_host, dest_port).await?;
        url.set_host(Some(&dialled.host)).map_err(|_| anyhow::anyhow!("adresse de tunnel invalide"))?;
        url.set_port(Some(dialled.port)).map_err(|_| anyhow::anyhow!("port de tunnel invalide"))?;
        inject_credentials(&mut url, &mongo.username, password.as_deref());
        (url.to_string(), dialled.tunnel)
    };

    // Refused up front rather than left to fail as an opaque TLS error: the
    // driver would dial `127.0.0.1` and reject a certificate issued for the
    // real endpoint, and "certificate not valid for name" says nothing about
    // the tunnel being the cause. See `MongoConfig::tls_insecure`.
    //
    // This bites hardest on DocumentDB, which is TLS-only *and* never
    // publicly reachable — i.e. exactly the deployment an SSM tunnel is for.
    if mongo.tls && !mongo.tunnel.is_direct() && !mongo.tls_insecure {
        db_tunnel::close(tunnel).await;
        anyhow::bail!(
            "TLS à travers un tunnel : le certificat du serveur ne peut pas correspondre à \
             127.0.0.1, l'adresse locale du tunnel. Cocher « ne pas vérifier le certificat » sur \
             cette connexion, ou se connecter sans tunnel."
        );
    }

    let build = async {
        let mut options = mongodb::options::ClientOptions::parse(&uri).await?;
        if mongo.tls {
            let mut tls_options = mongodb::options::TlsOptions::default();
            if let Some(path) = mongo.tls_ca_file.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                tls_options.ca_file_path = Some(std::path::PathBuf::from(path));
            }
            // Through a tunnel the URI now says `127.0.0.1`, which no server
            // certificate will ever carry — the name the certificate is issued
            // for is the one on the far side of the forward. Host *identity*
            // here is established by the tunnel itself (by SSH, or by IAM and
            // the SSM agent: either way we chose the far end and the forward
            // goes where we told it), so what TLS still has to prove is the
            // certificate chain, which stays verified. Only the name check is
            // dropped, and only when tunnelling.
            if mongo.tls_insecure {
                tls_options.allow_invalid_certificates = Some(true);
            }
            options.tls = Some(mongodb::options::Tls::Enabled(tls_options));
        }
        mongodb::Client::with_options(options)
    }
    .await;

    let client = match build {
        Ok(client) => client,
        Err(e) => {
            // The client never came up — nothing to close, but the tunnel
            // (if any) is already live and must still be torn down here,
            // since there's no `MongoSession` for the caller to `close()`.
            // Asked what really failed first: see `sql::connect`.
            let explained = tunnel.explain_failure(&e.to_string()).await;
            db_tunnel::close(tunnel).await;
            return Err(anyhow::anyhow!(explained));
        }
    };

    Ok(MongoSession { client, tunnel })
}

/// Server-internal databases hidden from the tree — same "cleaner default
/// list, not a security boundary" reasoning as `core::sql`'s
/// `MYSQL_SYSTEM_SCHEMAS`.
const MONGO_SYSTEM_DATABASES: [&str; 3] = ["admin", "local", "config"];

/// Every database on the server the client is connected to — unlike
/// PostgreSQL, MongoDB has no "must pick one at connect time" restriction
/// (closer to how `core::sql` already treats MySQL), so there's no
/// bootstrap-connection/`switch_sql_database`-style dance needed here at
/// all.
pub async fn list_databases(handle: MongoHandle) -> anyhow::Result<Vec<String>> {
    let names = handle.0.list_database_names().await?;
    Ok(names.into_iter().filter(|n| !MONGO_SYSTEM_DATABASES.contains(&n.as_str())).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub name: String,
    /// `"collection"` | `"view"` | `"timeseries"` — mirrors
    /// `core::sql::TableInfo::kind` (which shares the same rendering in the
    /// frontend's tree component for a schema's table list).
    pub kind: String,
}

pub async fn list_collections(handle: MongoHandle, database: &str) -> anyhow::Result<Vec<CollectionInfo>> {
    let db = handle.0.database(database);
    let mut cursor = db.list_collections().await?;
    let mut collections = Vec::new();
    while let Some(spec) = cursor.try_next().await? {
        let kind = match spec.collection_type {
            mongodb::results::CollectionType::Collection => "collection",
            mongodb::results::CollectionType::View => "view",
            mongodb::results::CollectionType::Timeseries => "timeseries",
            // `CollectionType` is `#[non_exhaustive]` (the server could
            // report a data-store kind this driver version predates) —
            // "collection" is the safest fallback rendering for one the
            // frontend doesn't specifically know how to label.
            _ => "collection",
        };
        collections.push(CollectionInfo { name: spec.name, kind: kind.to_string() });
    }
    collections.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(collections)
}

/// Parses the "Requête" tab's user-typed filter (MongoDB Extended JSON,
/// e.g. `{"age": {"$gt": 21}}` or `{"createdAt": {"$gte": {"$date":
/// "2026-01-01T00:00:00Z"}}}`) into a real BSON filter document — `bson`'s
/// own `TryFrom<serde_json::Value>` for `Bson` already understands both
/// canonical and relaxed extJSON wrapper objects (`$oid`/`$date`/…), so
/// there's no hand-rolled parsing needed for those on the way in, any more
/// than there is on the way out (see [`find_documents`]'s use of
/// `into_relaxed_extjson`). `None`/blank means "no filter" (used by the
/// "Données" tab).
fn parse_filter(filter_json: Option<&str>) -> anyhow::Result<Document> {
    let Some(text) = filter_json.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(Document::new());
    };
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| anyhow::anyhow!("filtre JSON invalide : {e}"))?;
    match Bson::try_from(value)? {
        Bson::Document(doc) => Ok(doc),
        _ => anyhow::bail!(r#"le filtre doit être un objet JSON, par exemple {{"age": {{"$gt": 21}}}}"#),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoQueryResult {
    pub documents: Vec<serde_json::Value>,
    /// `true` when more than `core::sql::MAX_RESULT_ROWS` documents matched
    /// — only the first that many are in `documents`. Same accepted "no
    /// pagination, hard cap" first-version limitation `core::sql::QueryResult`
    /// already documents.
    pub truncated: bool,
}

/// Runs `filter_json` (or, if `None`/blank, every document) against
/// `database.collection`, capped and streamed the same way
/// `core::sql::execute_query` caps `SELECT` results — backs both the
/// "Données" tab (`filter_json: None`) and the "Requête" tab (user-typed
/// filter), exactly like `execute_query` backs both SQL's "Data" and "Query"
/// tabs. Each returned document is rendered as relaxed MongoDB Extended
/// JSON (`$oid`/`$date`-style wrapper objects only where the JSON type
/// system genuinely can't represent the BSON type — plain numbers/strings/
/// booleans/arrays stay as their natural JSON form), the ecosystem-standard
/// representation `mongosh`/Compass also use, rather than a hand-rolled
/// conversion.
pub async fn find_documents(handle: MongoHandle, database: &str, collection: &str, filter_json: Option<&str>) -> anyhow::Result<MongoQueryResult> {
    let filter = parse_filter(filter_json)?;
    let coll = handle.0.database(database).collection::<Document>(collection);
    let cap = crate::sql::MAX_RESULT_ROWS;
    let mut cursor = coll.find(filter).limit(cap as i64 + 1).await?;

    let mut documents = Vec::new();
    let mut truncated = false;
    while let Some(doc) = cursor.try_next().await? {
        if documents.len() >= cap {
            truncated = true;
            break;
        }
        documents.push(Bson::Document(doc).into_relaxed_extjson());
    }
    Ok(MongoQueryResult { documents, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filter_returns_an_empty_document_for_blank_input() {
        assert_eq!(parse_filter(None).unwrap(), Document::new());
        assert_eq!(parse_filter(Some("")).unwrap(), Document::new());
        assert_eq!(parse_filter(Some("   ")).unwrap(), Document::new());
    }

    #[test]
    fn parse_filter_accepts_plain_json() {
        let doc = parse_filter(Some(r#"{"age": {"$gt": 21}, "city": "Paris"}"#)).unwrap();
        assert_eq!(doc.get_str("city").unwrap(), "Paris");
        assert_eq!(doc.get_document("age").unwrap().get_i32("$gt").unwrap(), 21);
    }

    #[test]
    fn parse_filter_accepts_extended_json_wrappers() {
        // $oid / $date wrapper objects — the whole point of using bson's own
        // `TryFrom<serde_json::Value>` rather than a hand-rolled parser.
        let doc = parse_filter(Some(r#"{"_id": {"$oid": "652f1f77bcf86cd799439011"}}"#)).unwrap();
        assert!(matches!(doc.get("_id"), Some(Bson::ObjectId(_))));
    }

    #[test]
    fn parse_filter_rejects_a_non_object_top_level_value() {
        assert!(parse_filter(Some("42")).is_err());
        assert!(parse_filter(Some("[1, 2, 3]")).is_err());
    }

    #[test]
    fn parse_filter_rejects_invalid_json() {
        assert!(parse_filter(Some("{not json")).is_err());
    }
}
