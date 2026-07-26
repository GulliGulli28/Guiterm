//! Real end-to-end coverage for a `Sqlite` `SqlConnection` whose file lives
//! on a saved SSH host, against an actual `sshd` (not a mock) — specifically
//! the data-loss bug `core::sql::SqlSession::close` used to have: closing a
//! session unconditionally re-uploaded its local temp copy, silently
//! clobbering whatever had changed on the origin file in the meantime, even
//! if the app itself never wrote anything.
mod common;

use common::{ClientKey, TestSshd, test_host};
use std::sync::atomic::AtomicBool;
use std::sync::LazyLock;
use termius_core::model::{EngineConfig, SqlConnection, SqliteConfig, Workspace};
use termius_core::sftp::{self, SftpClient};
use termius_core::sql;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Serializes every test in this file. Each spins up a real `sshd` plus two
/// SSH connections (one standing in for "the app", one for "some other tool
/// touching the file directly") and does several SFTP round trips —
/// harmless one at a time, but running all of this file's tests at once (the
/// default) was observed to occasionally trip a transient SFTP I/O hiccup
/// under the resulting load. That's indistinguishable, by design, from "the
/// remote file actually changed" (`fetch_remote_hash` fails closed on *any*
/// error — see its doc comment), so a flaky connection could otherwise
/// surface as a flaky, wrongly-failing test. Serializing costs a couple of
/// seconds of wall-clock time in exchange for never flaking under load.
static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A fresh local SQLite file with one table and, if given, one seed row.
async fn make_local_sqlite(seed_value: Option<&str>) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("guiterm-test-sqlite-src-{}.sqlite", Uuid::new_v4()));
    std::fs::File::create(&path).unwrap();
    let conn = SqlConnection::new_sqlite_local("seed", path.to_string_lossy().to_string());
    let workspace = Workspace::default();
    let session = sql::connect(&workspace, &conn).await.expect("connect to seed local sqlite");
    sql::execute_query(&session.pool, None, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await.expect("create table");
    if let Some(v) = seed_value {
        sql::execute_query(&session.pool, None, &format!("INSERT INTO t (v) VALUES ('{v}')")).await.expect("seed row");
    }
    session.close().await.expect("close seed session");
    path
}

/// Downloads whatever's currently at `remote_path` and reads back every
/// `t.v` value, ordered — used to assert on the *actual* remote content
/// after a close, rather than trusting anything cached in-process.
async fn read_remote_values(client: &SftpClient, remote_path: &str) -> Vec<String> {
    let (parent, name) = remote_path.rsplit_once('/').expect("absolute remote path");
    let parent = if parent.is_empty() { "/" } else { parent };
    let size = client.list(parent).await.unwrap().into_iter().find(|e| e.name == name).unwrap().size;
    let tmp = std::env::temp_dir().join(format!("guiterm-test-sqlite-check-{}.sqlite", Uuid::new_v4()));
    client.download(remote_path, &tmp, size, &AtomicBool::new(false), |_, _| {}).await.expect("download for verification");

    let conn = SqlConnection::new_sqlite_local("check", tmp.to_string_lossy().to_string());
    let workspace = Workspace::default();
    let session = sql::connect(&workspace, &conn).await.expect("open verification copy");
    let result = sql::execute_query(&session.pool, None, "SELECT v FROM t ORDER BY id").await.expect("select for verification");
    session.close().await.expect("close verification session");
    let _ = std::fs::remove_file(&tmp);

    result.rows.into_iter().map(|row| row[0].as_str().unwrap().to_string()).collect()
}

struct RemoteFixture {
    workspace: Workspace,
    host_id: termius_core::model::HostId,
    setup_client: SftpClient,
    remote_path: String,
    remote_dir: String,
    // Kept alive for as long as the fixture is: dropping `_key` deletes the
    // private key file `workspace`'s host still points at, dropping `_sshd`
    // kills the test server, dropping `_setup_connection` would tear down
    // the SSH connection `setup_client` runs over.
    _key: ClientKey,
    _sshd: TestSshd,
    _setup_connection: termius_core::ssh::Connection,
}

impl RemoteFixture {
    /// Best-effort — `sshd` runs as the real current OS user (see
    /// `test_host`), so its "home directory" is this machine's actual home
    /// directory; without cleanup, every test run would leave a stray
    /// `guiterm-test-sqlite-*` directory behind there.
    async fn cleanup(&self) {
        let _ = self.setup_client.remove_file(&self.remote_path).await;
        let _ = self.setup_client.remove_dir(&self.remote_dir).await;
    }
}

async fn setup(name: &str, seed_value: Option<&str>) -> RemoteFixture {
    let key = ClientKey::generate();
    let sshd = TestSshd::start(name, &key.public);
    let host = test_host(&sshd, &key, name);
    let host_id = host.id;

    let mut workspace = Workspace::default();
    workspace.hosts.push(host);

    let seed_path = make_local_sqlite(seed_value).await;
    let setup_connection = termius_core::ssh::connect(&workspace, host_id).await.expect("connect for setup");
    let setup_client = SftpClient::open(&setup_connection).await.expect("open sftp for setup");
    let home = setup_client.home_dir().await.expect("home dir");
    // A fresh subdirectory, not directly under `home` — `sshd` runs as the
    // real current OS user, so `home` is this machine's actual home
    // directory, shared by every test in this file; without a unique
    // subdirectory per fixture, parallel `cargo test` runs would silently
    // stomp on each other's "app.sqlite" through that one shared path.
    let remote_dir = sftp::join(&home, &format!("guiterm-test-sqlite-{}", Uuid::new_v4()));
    setup_client.make_dir(&remote_dir).await.expect("mkdir for fixture");
    let remote_path = sftp::join(&remote_dir, "app.sqlite");
    setup_client
        .upload(&seed_path, &remote_path, &AtomicBool::new(false), |_, _| {})
        .await
        .expect("seed upload");
    let _ = std::fs::remove_file(&seed_path);

    RemoteFixture { workspace, host_id, setup_client, remote_path, remote_dir, _key: key, _sshd: sshd, _setup_connection: setup_connection }
}

fn sqlite_connection(fixture: &RemoteFixture) -> SqlConnection {
    SqlConnection::new(
        "remote-db",
        EngineConfig::Sqlite(SqliteConfig {
            path: fixture.remote_path.clone(),
            sqlite_host_id: Some(fixture.host_id),
        }),
    )
}

#[tokio::test]
async fn closing_a_read_only_remote_sqlite_session_does_not_clobber_a_concurrent_external_edit() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-readonly", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    let seen = sql::execute_query(&session.pool, None, "SELECT v FROM t").await.expect("read-only query");
    assert_eq!(seen.rows.len(), 1);

    // Someone/something else edits the file directly on the host while our
    // session is still open.
    let edited_path = make_local_sqlite(Some("edited-concurrently")).await;
    fixture
        .setup_client
        .upload(&edited_path, &fixture.remote_path, &AtomicBool::new(false), |_, _| {})
        .await
        .expect("concurrent external edit");
    let _ = std::fs::remove_file(&edited_path);

    session.close().await.expect("closing a read-only session must never fail");

    let rows = read_remote_values(&fixture.setup_client, &fixture.remote_path).await;
    assert_eq!(rows, vec!["edited-concurrently".to_string()], "the concurrent external edit must survive closing an untouched session");
    fixture.cleanup().await;
}

#[tokio::test]
async fn closing_a_modified_remote_sqlite_session_writes_back_when_nothing_else_changed_it() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-writeback", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    sql::execute_query(&session.pool, None, "INSERT INTO t (v) VALUES ('added-locally')").await.expect("insert");
    session.close().await.expect("no concurrent change — write-back should succeed");

    let rows = read_remote_values(&fixture.setup_client, &fixture.remote_path).await;
    assert_eq!(rows, vec!["original".to_string(), "added-locally".to_string()]);
    fixture.cleanup().await;
}

#[tokio::test]
async fn closing_a_modified_remote_sqlite_session_refuses_to_overwrite_a_concurrent_external_edit() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-conflict", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    sql::execute_query(&session.pool, None, "INSERT INTO t (v) VALUES ('added-locally')").await.expect("insert");

    let edited_path = make_local_sqlite(Some("edited-concurrently")).await;
    fixture
        .setup_client
        .upload(&edited_path, &fixture.remote_path, &AtomicBool::new(false), |_, _| {})
        .await
        .expect("concurrent external edit");
    let _ = std::fs::remove_file(&edited_path);

    let result = session.close().await;
    assert!(result.is_err(), "a concurrent remote change must block the write-back rather than silently overwrite it");

    let rows = read_remote_values(&fixture.setup_client, &fixture.remote_path).await;
    assert_eq!(rows, vec!["edited-concurrently".to_string()], "the remote file must be untouched by the refused write-back");
    fixture.cleanup().await;
}

async fn select_values(pool: &sql::SqlPool) -> Vec<String> {
    sql::execute_query(pool, None, "SELECT v FROM t ORDER BY id")
        .await
        .expect("select values")
        .rows
        .into_iter()
        .map(|row| row[0].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn resync_is_a_no_op_when_nothing_changed_anywhere() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-resync-noop", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let mut session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    session.resync().await.expect("resync with nothing changed should succeed");
    assert_eq!(select_values(&session.pool).await, vec!["original".to_string()]);

    session.close().await.expect("close after a no-op resync");
    fixture.cleanup().await;
}

#[tokio::test]
async fn resync_adopts_a_remote_change_when_the_local_copy_is_untouched() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-resync-adopt", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let mut session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");

    // Someone else edits the host file while our session is open — nothing
    // local has changed.
    let edited_path = make_local_sqlite(Some("edited-remotely")).await;
    fixture.setup_client.upload(&edited_path, &fixture.remote_path, &AtomicBool::new(false), |_, _| {}).await.expect("concurrent external edit");
    let _ = std::fs::remove_file(&edited_path);

    session.resync().await.expect("resync should adopt the remote change");
    assert_eq!(select_values(&session.pool).await, vec!["edited-remotely".to_string()], "resync should have swapped in the host's new content");

    session.close().await.expect("close after adopting remote content — nothing local changed since");
    fixture.cleanup().await;
}

#[tokio::test]
async fn resync_pushes_local_changes_when_nothing_else_changed_remotely() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-resync-push", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let mut session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    sql::execute_query(&session.pool, None, "INSERT INTO t (v) VALUES ('added-locally')").await.expect("insert");

    session.resync().await.expect("resync should push the local change");
    let rows = read_remote_values(&fixture.setup_client, &fixture.remote_path).await;
    assert_eq!(rows, vec!["original".to_string(), "added-locally".to_string()], "resync should have pushed the local insert to the host");

    // Closing afterward shouldn't need to push again — `resync` already
    // rebaselined the snapshot to the pushed content.
    session.close().await.expect("close after a resync that already synced everything");
    fixture.cleanup().await;
}

#[tokio::test]
async fn resync_refuses_to_overwrite_a_concurrent_external_edit() {
    let _guard = TEST_LOCK.lock().await;
    let fixture = setup("sqlite-resync-conflict", Some("original")).await;
    let conn = sqlite_connection(&fixture);

    let mut session = sql::connect(&fixture.workspace, &conn).await.expect("open app session");
    sql::execute_query(&session.pool, None, "INSERT INTO t (v) VALUES ('added-locally')").await.expect("insert");

    let edited_path = make_local_sqlite(Some("edited-concurrently")).await;
    fixture.setup_client.upload(&edited_path, &fixture.remote_path, &AtomicBool::new(false), |_, _| {}).await.expect("concurrent external edit");
    let _ = std::fs::remove_file(&edited_path);

    assert!(session.resync().await.is_err(), "resync must refuse when the remote file changed independently");

    // The session is still usable afterward, with its own local change intact.
    assert_eq!(
        select_values(&session.pool).await,
        vec!["original".to_string(), "added-locally".to_string()],
        "the session's own local change must survive a refused resync",
    );
    let rows = read_remote_values(&fixture.setup_client, &fixture.remote_path).await;
    assert_eq!(rows, vec!["edited-concurrently".to_string()], "the remote file must remain untouched by the refused resync");

    // The conflict is still unresolved — close() should (correctly) refuse too.
    assert!(session.close().await.is_err(), "close should also refuse — the conflict from the failed resync is still there");
    fixture.cleanup().await;
}
