//! Redis client — connects either directly to a Redis server or tunnelled
//! through an existing saved SSH host (see [`crate::model::SqlConnection::tunnel_host_id`],
//! reusing the exact same ephemeral-port-forward mechanism [`crate::sql::connect`]
//! already uses), browses keys via bounded `SCAN` batches, reads a key's
//! value in a type-aware shape, and runs arbitrary raw commands.
//!
//! Named `redis_client` rather than `redis` so `use redis::...` inside this
//! module never needs `crate::`/`self::` disambiguation against the crate of
//! the same name (mirrors why `core::sql` isn't named `sqlx`). Lives in
//! `core/` directly, like `sql`, rather than a separate sidecar process (see
//! `core::sql`'s own module doc comment for why that question gets asked at
//! all in this codebase, and CLAUDE.md's "Pourquoi un processus RDP séparé"
//! for the one case where the answer was "yes, separate process") — the
//! `redis` crate resolves cleanly against this workspace's existing
//! dependency graph (verified via `cargo check` before writing this module),
//! no exact-pin conflict like `ironrdp-connector`'s `picky` had.
//!
//! **Deliberately not a `SqlPool`/`SqlEngine` case in `core::sql`.** A
//! key-value store has no schema/table tree and no SQL query language to
//! browse or run — the frontend renders a Redis connection through
//! `RedisTab`, a completely different component from `SqlTab`, not a new
//! branch inside it. `SqlConnection`/`SqlEngine::Redis` are still shared
//! (see their doc comments for exactly which fields Redis reuses and what
//! they mean here), since a saved connection's CRUD (`commands::sql::
//! save_sql_connection`/`delete_sql_connection`) is already fully generic
//! over `engine` and needs no changes at all for a new engine that doesn't
//! introduce new persisted fields.
//!
//! **Bounded, never buffered-without-limit** — the same discipline
//! `core::sql`'s `MAX_RESULT_ROWS` and `core::sftp`'s `MAX_EDIT_BYTES`
//! already establish. [`scan_keys`] never issues an unbounded `KEYS *`; both
//! it and the hash/set readers inside [`get_value`] loop over `SCAN`-family
//! cursors internally (a single `SCAN` call is *not* guaranteed to return
//! any keys even when more remain — especially under a `MATCH` pattern most
//! of the keyspace doesn't hit — so a naive one-shot call could look empty
//! when it isn't) up to a hard round cap, never pulling more than
//! [`MAX_KEYS_PER_PAGE`]/[`MAX_COLLECTION_ITEMS`] items into memory at once.
//!
//! **No TLS in this first version** — `core::sql::build_url` has no TLS
//! support today for MySQL/PostgreSQL either, so adding it uniquely for
//! Redis would be a scope inconsistency; it also wouldn't make sense through
//! this module's SSH-tunnel path specifically (a certificate issued for the
//! real hostname would never match `127.0.0.1`, the tunnel's local endpoint).
//! Revisit as a cross-engine addition later if it's ever needed, not here.
use crate::db_tunnel::{self, OpenTunnel};
use crate::model::{EngineConfig, SqlConnection, Workspace};
use crate::sql::hex_encode;
use crate::vault::{self, SecretKind};
use serde::Serialize;

/// The live connection behind a [`RedisSession`] — deliberately opaque
/// (wraps `redis::aio::ConnectionManager` privately) so `commands::redis` in
/// `src-tauri` never needs a direct dependency on the `redis` crate, only on
/// this type — the same invariant `core::sql::SqlPool` already keeps for
/// `sqlx` (`commands::sql` never names `sqlx::PgPool` etc.). Cheap to
/// `Clone` (the manager itself is `Arc`-based internally, built to be shared
/// across concurrent callers), which is why the Tauri command layer can
/// clone it out of a `std::sync::Mutex`-guarded session map and drop the
/// lock before awaiting, exactly like `SqlPool` already does.
#[derive(Clone)]
pub struct RedisHandle(redis::aio::ConnectionManager);

/// A live Redis connection: the manager, plus — when tunnelled — whatever's
/// needed to keep that alive for as long as the manager is. Dropping this
/// without calling [`close`](RedisSession::close) first leaves the tunnel's
/// accept loop running detached, exactly the same caveat `core::sql::SqlSession`
/// already documents for its own tunnel field.
pub struct RedisSession {
    manager: redis::aio::ConnectionManager,
    /// The numbered database (0–15 by default) this session is scoped to —
    /// surfaced back to the frontend purely for display, since it can't be
    /// changed without reconnecting (unlike MySQL's `USE`, Redis has no
    /// per-command database override).
    pub database: u8,
    tunnel: OpenTunnel,
}

impl RedisSession {
    pub fn handle(&self) -> RedisHandle {
        RedisHandle(self.manager.clone())
    }

    pub async fn close(self) -> anyhow::Result<()> {
        db_tunnel::close(self.tunnel).await;
        Ok(())
    }
}

/// Connects `conn` — directly, or (when `tunnel_host_id` is set) via an
/// ephemeral SSH local port forward through that saved host first, exactly
/// like `core::sql::connect` (never persisted / never visible in the
/// Tunnels panel: built in memory with `bind_port: 0`, torn down by
/// [`RedisSession::close`]).
pub async fn connect(workspace: &Workspace, conn: &SqlConnection) -> anyhow::Result<RedisSession> {
    let EngineConfig::Redis(server) = &conn.config else {
        anyhow::bail!("redis_client::connect ne s'applique qu'aux connexions Redis");
    };

    let database = match server.database.as_deref().filter(|d| !d.is_empty()) {
        None => 0u8,
        Some(raw) => raw
            .parse::<u8>()
            .ok()
            .filter(|n| *n <= 15)
            .ok_or_else(|| anyhow::anyhow!("index de base Redis invalide (attendu : 0 à 15) : {raw:?}"))?,
    };

    let password = vault::load(conn.id, SecretKind::SqlPassword)?;

    let dialled = db_tunnel::open(workspace, &server.tunnel, &server.address, server.port).await?;

    let url = build_url(
        server.tls,
        &dialled.host,
        dialled.port,
        &server.username,
        password.as_deref(),
        database,
    )?;

    let connect_result = async {
        let client = redis::Client::open(url.as_str())?;
        redis::aio::ConnectionManager::new(client).await
    }
    .await;

    let manager = match connect_result {
        Ok(manager) => manager,
        Err(e) => {
            // The manager never came up — nothing to close, but the tunnel
            // (if any) is already live and must still be torn down here,
            // since there's no `RedisSession` for the caller to `close()`.
            // Asked what really failed first: see `sql::connect`.
            let explained = dialled.tunnel.explain_failure(&e.to_string()).await;
            db_tunnel::close(dialled.tunnel).await;
            return Err(anyhow::anyhow!(explained));
        }
    };

    Ok(RedisSession { manager, database, tunnel: dialled.tunnel })
}

/// Builds the URL handed to `redis::Client::open`.
///
/// Extracted from [`connect`] so the one decision that cannot be observed
/// without a live server — which scheme gets dialled — is testable: reverting
/// it to a hardcoded `redis://` compiled cleanly and broke no test, which is
/// how an encrypted cluster would come to be dialled in the clear (and hang,
/// rather than fail).
///
/// Built via `url::Url`'s setters, never hand-`format!`-ed — same
/// safe-percent-encoding reasoning as `core::sql::build_url`. The caller turns
/// it into a plain string rather than passing the `Url` itself, so this never
/// depends on this workspace's `url` version matching whatever `redis`
/// resolves internally.
fn build_url(
    tls: bool,
    host: &str,
    port: u16,
    username: &str,
    password: Option<&str>,
    database: u8,
) -> anyhow::Result<url::Url> {
    // `rediss://` is the scheme redis-rs keys TLS off; nothing else about the
    // URL changes. Certificates are checked against the system roots, which is
    // what ElastiCache needs — its certificates chain to a public CA.
    let scheme = if tls { "rediss" } else { "redis" };
    let mut url = url::Url::parse(&format!("{scheme}://placeholder")).expect("valid literal");
    url.set_host(Some(host)).map_err(|_| anyhow::anyhow!("adresse invalide : {host:?}"))?;
    url.set_port(Some(port)).map_err(|_| anyhow::anyhow!("port invalide"))?;
    if !username.is_empty() {
        url.set_username(username).map_err(|_| anyhow::anyhow!("nom d'utilisateur invalide"))?;
    }
    url.set_password(password.filter(|p| !p.is_empty())).map_err(|_| anyhow::anyhow!("mot de passe invalide"))?;
    url.set_path(&database.to_string());
    Ok(url)
}

/// Row batch cap for [`scan_keys`] — the tree's flat, paginated key list is
/// deliberately not a colon-namespaced virtual folder tree (that would need
/// to see far more of the keyspace up front to group anything); a search
/// pattern plus "charger plus" is the safe default for a keyspace that can
/// hold millions of entries.
pub const MAX_KEYS_PER_PAGE: usize = 200;
/// Item cap for a single key's value in [`get_value`] — smaller than
/// [`MAX_KEYS_PER_PAGE`]/`core::sql::MAX_RESULT_ROWS`: this renders inline in
/// one pane, not a scrollable results table, so a much larger cap would make
/// the "Valeur" tab itself unwieldy well before memory/network would be a
/// concern.
pub const MAX_COLLECTION_ITEMS: usize = 500;
/// `COUNT` hint passed on each `SCAN`-family round trip — a hint only (Redis
/// may return more or fewer), sized to keep typical round-trip counts low
/// without pulling much more than a page/collection actually needs.
const SCAN_COUNT_HINT: i64 = 100;
/// Hard cap on `SCAN`-family round trips per call, bounding worst-case
/// latency against a huge keyspace where a rare-matching pattern could
/// otherwise force many empty-looking rounds before the cursor wraps to 0.
const MAX_SCAN_ROUNDS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyEntry {
    pub key: String,
    pub key_type: String,
    pub ttl_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    pub keys: Vec<RedisKeyEntry>,
    /// `0` once the keyspace (or everything matching `pattern`) has been
    /// fully iterated — the frontend's "charger plus" button hides once this
    /// comes back `0`, same convention as any cursor-based pagination.
    pub cursor: u64,
}

/// Turns `-1`/`-2`/an actual seconds count from a raw `TTL` reply into the
/// `Option<i64>` shape the frontend renders — `None` covers "no expiry" and
/// "key doesn't exist" alike, since both mean "no TTL badge to show".
fn ttl_from_raw(raw: i64) -> Option<i64> {
    if raw >= 0 { Some(raw) } else { None }
}

/// Paginated key listing — never `KEYS *` (see this module's doc comment).
/// `pattern`, if given and containing no glob metacharacter (`*`/`?`/`[`),
/// is wrapped as `*pattern*` (a plain substring search, what a search box
/// implies) rather than passed as an exact-match glob; passed through
/// verbatim otherwise, for a user who types a real glob on purpose.
pub async fn scan_keys(handle: RedisHandle, cursor: u64, pattern: Option<&str>) -> anyhow::Result<ScanPage> {
    let mut manager = handle.0;
    let match_pattern = pattern.filter(|p| !p.is_empty()).map(|p| {
        if p.contains(['*', '?', '[']) { p.to_string() } else { format!("*{p}*") }
    });

    let mut collected: Vec<String> = Vec::new();
    let mut cur = cursor;
    for _ in 0..MAX_SCAN_ROUNDS {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(cur).arg("COUNT").arg(SCAN_COUNT_HINT);
        if let Some(p) = &match_pattern {
            cmd.arg("MATCH").arg(p);
        }
        let (next_cursor, mut batch): (u64, Vec<String>) = cmd.query_async(&mut manager).await?;
        collected.append(&mut batch);
        cur = next_cursor;
        if cur == 0 || collected.len() >= MAX_KEYS_PER_PAGE {
            break;
        }
    }
    collected.truncate(MAX_KEYS_PER_PAGE);

    if collected.is_empty() {
        return Ok(ScanPage { keys: Vec::new(), cursor: cur });
    }

    // TYPE + TTL for the whole batch in one round trip rather than one per
    // key — `redis::Value` (identity `FromRedisValue`) is the only type that
    // can hold both an integer and a string reply in the same `Vec`, since
    // the two commands' reply shapes differ.
    let mut pipe = redis::pipe();
    for key in &collected {
        pipe.cmd("TYPE").arg(key);
        pipe.cmd("TTL").arg(key);
    }
    let replies: Vec<redis::Value> = pipe.query_async(&mut manager).await?;

    let keys = collected
        .into_iter()
        .zip(replies.chunks(2))
        .filter_map(|(key, chunk)| {
            let key_type: String = redis::from_redis_value(chunk[0].clone()).unwrap_or_else(|_| "none".to_string());
            // Vanished between the SCAN batch and this pipeline (expired or
            // deleted concurrently) — a benign race, just drop it from this
            // page rather than showing a nonsensical entry.
            if key_type == "none" {
                return None;
            }
            let ttl_secs = redis::from_redis_value::<i64>(chunk[1].clone()).ok().and_then(ttl_from_raw);
            Some(RedisKeyEntry { key, key_type, ttl_secs })
        })
        .collect();

    Ok(ScanPage { keys, cursor: cur })
}

/// An internally-tagged enum with struct variants — `rename_all_fields` (not
/// just `rename_all`) is required for e.g. `type_name`/`item_name` to
/// actually deserialize as `typeName`/`itemName` on the frontend side; see
/// CLAUDE.md's note on this exact gotcha, already hit 6 times in this
/// project before this one.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RedisValue {
    String { value: String },
    Hash { entries: Vec<(String, String)>, truncated: bool },
    List { items: Vec<String>, truncated: bool },
    Set { members: Vec<String>, truncated: bool },
    SortedSet { members: Vec<(String, f64)>, truncated: bool },
    /// Streams, module types (RedisJSON, Bloom filters, …) — anything this
    /// module doesn't render structurally. The Console tab still reaches it
    /// via raw commands (e.g. `XRANGE`, `JSON.GET`).
    Unsupported { type_name: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyDetail {
    pub key_type: String,
    pub ttl_secs: Option<i64>,
    pub value: RedisValue,
}

/// Bounded `HSCAN`/`SSCAN` loop shared by the `Hash`/`Set` branches of
/// [`get_value`] — same "a single SCAN-family call isn't guaranteed to
/// return anything even with more left" caution as [`scan_keys`], just
/// scoped to one key's collection instead of the whole keyspace. Returns the
/// flat reply list (HSCAN: alternating field/value; SSCAN: members) plus
/// whether the collection was cut off before full iteration completed
/// (`cursor != 0` when the loop stopped — either the cap was hit, or the
/// round cap was, before the server ever reported "done").
async fn bounded_key_scan(manager: &mut redis::aio::ConnectionManager, cmd_name: &str, key: &str, cap: usize) -> anyhow::Result<(Vec<String>, bool)> {
    let mut collected: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    let mut truncated = false;
    for round in 0..MAX_SCAN_ROUNDS {
        let (next_cursor, mut batch): (u64, Vec<String>) = redis::cmd(cmd_name)
            .arg(key)
            .arg(cursor)
            .arg("COUNT")
            .arg(SCAN_COUNT_HINT)
            .query_async(manager)
            .await?;
        collected.append(&mut batch);
        cursor = next_cursor;
        if cursor == 0 {
            break;
        }
        if collected.len() >= cap || round == MAX_SCAN_ROUNDS - 1 {
            truncated = true;
            break;
        }
    }
    Ok((collected, truncated))
}

/// Reads `key`'s current type/TTL/value — `None` if it no longer exists
/// (including the race where it expired between being listed by
/// [`scan_keys`] and this call). Bounded for every collection type: `List`/
/// `SortedSet` via an index range plus a separate `LLEN`/`ZCARD` for the
/// precise `truncated` flag (no scan needed — both support direct range
/// reads); `Hash`/`Set` via [`bounded_key_scan`], whose own cursor tells us
/// `truncated` for free.
pub async fn get_value(handle: RedisHandle, key: &str) -> anyhow::Result<Option<RedisKeyDetail>> {
    let mut manager = handle.0;

    let key_type: String = redis::cmd("TYPE").arg(key).query_async(&mut manager).await?;
    if key_type == "none" {
        return Ok(None);
    }
    let ttl_secs = redis::cmd("TTL").arg(key).query_async::<i64>(&mut manager).await.ok().and_then(ttl_from_raw);

    let cap = MAX_COLLECTION_ITEMS;
    let value = match key_type.as_str() {
        "string" => {
            let value: String = redis::cmd("GET").arg(key).query_async(&mut manager).await?;
            RedisValue::String { value }
        }
        "list" => {
            let total: i64 = redis::cmd("LLEN").arg(key).query_async(&mut manager).await?;
            let items: Vec<String> = redis::cmd("LRANGE").arg(key).arg(0).arg(cap as isize - 1).query_async(&mut manager).await?;
            RedisValue::List { truncated: (total as usize) > items.len(), items }
        }
        "hash" => {
            let (flat, truncated) = bounded_key_scan(&mut manager, "HSCAN", key, cap * 2).await?;
            let entries = flat.chunks(2).filter(|c| c.len() == 2).map(|c| (c[0].clone(), c[1].clone())).take(cap).collect();
            RedisValue::Hash { entries, truncated }
        }
        "set" => {
            let (members, truncated) = bounded_key_scan(&mut manager, "SSCAN", key, cap).await?;
            RedisValue::Set { truncated: truncated || members.len() > cap, members: members.into_iter().take(cap).collect() }
        }
        "zset" => {
            let total: i64 = redis::cmd("ZCARD").arg(key).query_async(&mut manager).await?;
            let members: Vec<(String, f64)> = redis::cmd("ZRANGE").arg(key).arg(0).arg(cap as isize - 1).arg("WITHSCORES").query_async(&mut manager).await?;
            RedisValue::SortedSet { truncated: (total as usize) > members.len(), members }
        }
        other => RedisValue::Unsupported { type_name: other.to_string() },
    };

    Ok(Some(RedisKeyDetail { key_type, ttl_secs, value }))
}

/// Splits a Console-tab command line into arguments — whitespace-separated,
/// with `'...'`/`"..."` quoting (a `\` inside a quoted span escapes that same
/// quote character, nothing else) so a value containing spaces can be typed
/// directly, matching `redis-cli`'s own basic argument shape rather than a
/// full shell grammar.
pub fn tokenize_command(line: &str) -> anyhow::Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some(ch) if ch == '\\' && chars.peek() == Some(&c) => {
                            current.push(c);
                            chars.next();
                        }
                        Some(ch) if ch == c => break,
                        Some(ch) => current.push(ch),
                        None => anyhow::bail!("guillemet non fermé"),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            c => {
                current.push(c);
                in_token = true;
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    Ok(tokens)
}

/// A generic RESP reply, rendered for the Console tab — untagged so `Nil`
/// serializes as bare `null`, `Int`/`Text` as a bare number/string, `List` as
/// a bare JSON array, and only `Error` needs its own shape (`{"error":
/// "..."}`) to stay distinguishable from an ordinary string reply.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RedisReply {
    Nil,
    Int(i64),
    Text(String),
    List(Vec<RedisReply>),
    Error { error: String },
}

fn reply_to_json(value: redis::Value) -> RedisReply {
    match value {
        redis::Value::Nil => RedisReply::Nil,
        redis::Value::Int(n) => RedisReply::Int(n),
        redis::Value::Okay => RedisReply::Text("OK".to_string()),
        redis::Value::SimpleString(s) => RedisReply::Text(s),
        // Binary-unsafe bulk strings fall back to the same `\xNN...` hex
        // convention `core::sql`'s decoders already use for genuine binary
        // blobs, rather than inventing a second one.
        redis::Value::BulkString(bytes) => match String::from_utf8(bytes) {
            Ok(s) => RedisReply::Text(s),
            Err(e) => RedisReply::Text(hex_encode(&e.into_bytes())),
        },
        redis::Value::VerbatimString { text, .. } => RedisReply::Text(text),
        redis::Value::Double(d) => RedisReply::Text(d.to_string()),
        redis::Value::Boolean(b) => RedisReply::Int(i64::from(b)),
        redis::Value::Array(items) | redis::Value::Set(items) => RedisReply::List(items.into_iter().map(reply_to_json).collect()),
        redis::Value::Map(pairs) => RedisReply::List(pairs.into_iter().flat_map(|(k, v)| [reply_to_json(k), reply_to_json(v)]).collect()),
        redis::Value::Attribute { data, .. } => reply_to_json(*data),
        // RESP3-only shapes this connection never negotiates in practice
        // (protocol defaults to RESP2 — see `connect`'s URL, which sets no
        // `protocol` query param) — kept for exhaustiveness, best-effort.
        other => RedisReply::Text(format!("{other:?}")),
    }
}

/// Runs a raw command typed into the Console tab — no command blocklist
/// (`FLUSHALL`/`CONFIG`/etc. all pass through unchanged), matching this
/// app's existing SQL Query tab, which is equally permissive for the same
/// reason: a console is meant to be the full-power escape hatch, not a
/// second, more restrictive query surface. `MULTI`/`EXEC`/`WATCH` aren't
/// guaranteed to behave correctly here — `ConnectionManager` multiplexes
/// many logical callers over one real connection, and interleaving another
/// caller's command between a `MULTI` and its `EXEC` is possible; acceptable
/// for this app's single-tab, mostly-sequential usage, but worth knowing.
pub async fn run_command(handle: RedisHandle, line: &str) -> anyhow::Result<RedisReply> {
    let tokens = tokenize_command(line)?;
    let Some((name, args)) = tokens.split_first() else {
        anyhow::bail!("commande vide");
    };
    let mut manager = handle.0;
    let mut cmd = redis::cmd(name);
    for arg in args {
        cmd.arg(arg);
    }
    match cmd.query_async::<redis::Value>(&mut manager).await {
        Ok(value) => Ok(reply_to_json(value)),
        Err(e) => Ok(RedisReply::Error { error: e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::build_url;

    /// The whole point of the `tls` flag: an ElastiCache group with
    /// encryption in transit must be dialled over TLS. Getting this wrong
    /// doesn't fail — it hangs, which is the least diagnosable outcome there
    /// is.
    #[test]
    fn tls_selects_the_rediss_scheme() {
        let plain = build_url(false, "cache.example", 6379, "", None, 0u8).unwrap();
        assert_eq!(plain.scheme(), "redis");
        let secure = build_url(true, "cache.example", 6379, "", None, 0u8).unwrap();
        assert_eq!(secure.scheme(), "rediss");
    }

    #[test]
    fn the_database_index_and_credentials_survive_the_url() {
        let url = build_url(true, "cache.example", 6380, "acl-user", Some("p@ss:w/rd"), 3u8).unwrap();
        assert_eq!(url.host_str(), Some("cache.example"));
        assert_eq!(url.port(), Some(6380));
        assert_eq!(url.path(), "/3");
        assert_eq!(url.username(), "acl-user");
        // Percent-encoded rather than breaking the URL structure, same as
        // `sql::build_url`.
        assert_eq!(url.password(), Some("p%40ss%3Aw%2Frd"));
    }

    #[test]
    fn an_empty_password_is_left_out_entirely() {
        let url = build_url(false, "cache.example", 6379, "", Some(""), 0u8).unwrap();
        assert_eq!(url.password(), None);
    }

    use super::*;

    #[test]
    fn tokenize_splits_plain_whitespace_separated_args() {
        assert_eq!(tokenize_command("HSET user:1 name Alice").unwrap(), vec!["HSET", "user:1", "name", "Alice"]);
    }

    #[test]
    fn tokenize_handles_quoted_args_with_spaces() {
        assert_eq!(
            tokenize_command(r#"SET greeting "hello world""#).unwrap(),
            vec!["SET", "greeting", "hello world"]
        );
        assert_eq!(tokenize_command("SET name 'Jean Dupont'").unwrap(), vec!["SET", "name", "Jean Dupont"]);
    }

    #[test]
    fn tokenize_handles_escaped_quote_inside_a_quoted_arg() {
        assert_eq!(tokenize_command(r#"SET s "it\"s here""#).unwrap(), vec!["SET", "s", "it\"s here"]);
    }

    #[test]
    fn tokenize_rejects_an_unterminated_quote() {
        assert!(tokenize_command("SET key \"unterminated").is_err());
    }

    #[test]
    fn tokenize_returns_empty_for_blank_input() {
        assert!(tokenize_command("   ").unwrap().is_empty());
    }

    #[test]
    fn ttl_from_raw_maps_sentinels_and_real_values() {
        assert_eq!(ttl_from_raw(-2), None); // key doesn't exist
        assert_eq!(ttl_from_raw(-1), None); // no expiry
        assert_eq!(ttl_from_raw(0), Some(0));
        assert_eq!(ttl_from_raw(120), Some(120));
    }

    #[test]
    fn reply_to_json_converts_every_common_resp2_shape() {
        assert!(matches!(reply_to_json(redis::Value::Nil), RedisReply::Nil));
        assert!(matches!(reply_to_json(redis::Value::Int(42)), RedisReply::Int(42)));
        assert!(matches!(reply_to_json(redis::Value::Okay), RedisReply::Text(s) if s == "OK"));
        assert!(matches!(reply_to_json(redis::Value::BulkString(b"hello".to_vec())), RedisReply::Text(s) if s == "hello"));
        // Genuinely binary (non-UTF-8) data falls back to the shared hex
        // convention rather than panicking or lossily replacing bytes.
        assert!(matches!(
            reply_to_json(redis::Value::BulkString(vec![0xff, 0x00, 0xab])),
            RedisReply::Text(s) if s == "\\xff00ab"
        ));
        let nested = reply_to_json(redis::Value::Array(vec![redis::Value::Int(1), redis::Value::BulkString(b"two".to_vec())]));
        match nested {
            RedisReply::List(items) => {
                assert!(matches!(items[0], RedisReply::Int(1)));
                assert!(matches!(&items[1], RedisReply::Text(s) if s == "two"));
            }
            _ => panic!("expected a List"),
        }
    }
}
