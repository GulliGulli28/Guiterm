//! Shared helpers for integration tests that need a real `sshd` to talk to.
#![allow(dead_code)]
use std::collections::HashSet;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Ports already handed out in this process.
///
/// [`free_port`] can only report a port that was free a moment ago, never one
/// it still holds — the whole point is to release it so `sshd` (or a forward)
/// can take it. In that gap the kernel is free to hand the same ephemeral port
/// to the next caller, and these tests run in parallel in a single binary, so
/// the next caller is usually another test starting at the same instant. This
/// set is what stops two of them being pointed at the same port.
///
/// Only ever grows: a test binary hands out a few dozen ports and exits.
fn claimed_ports() -> &'static Mutex<HashSet<u16>> {
    static CLAIMED: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub struct TestSshd {
    dir: PathBuf,
    pub port: u16,
    child: Child,
}

impl TestSshd {
    pub fn start(name: &str, client_pubkey_path: &Path) -> Self {
        let dir =
            std::env::temp_dir().join(format!("guiterm-test-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let host_key = dir.join("host_key");
        run_ok(
            Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-f"])
                .arg(&host_key)
                .args(["-N", ""]),
        );

        let authorized_keys = dir.join("authorized_keys");
        std::fs::copy(client_pubkey_path, &authorized_keys).unwrap();

        // The port can still be taken between being reported free and `sshd`
        // binding it — by something outside this process, which no bookkeeping
        // here can prevent. So the attempt is simply retried on a fresh port.
        let config_path = dir.join("sshd_config");
        let mut last_port = 0;
        for _ in 0..5 {
            let port = free_port();
            last_port = port;
            let mut config = std::fs::File::create(&config_path).unwrap();
            writeln!(
                config,
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
                 PasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n\
                 UsePAM no\nStrictModes no\nAllowTcpForwarding yes\nGatewayPorts yes\nSubsystem sftp internal-sftp\n",
                host_key.display(),
                authorized_keys.display(),
            )
            .unwrap();

            let mut child = Command::new("/usr/sbin/sshd")
                .args(["-f"])
                .arg(&config_path)
                .args(["-D", "-e"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn sshd - is openssh-server installed?");

            if wait_until_listening(&mut child, port) {
                return Self { dir, port, child };
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        panic!("sshd n'a pas réussi à écouter après 5 tentatives (dernier port {last_port})");
    }
}

/// Whether *this* `sshd` is the one now accepting connections on `port`.
///
/// Liveness is the real test, not the connect. If something else holds the
/// port, a plain `connect` succeeds regardless and the suite would run against
/// a stranger's server — whose `authorized_keys` is not ours — failing much
/// later as an inexplicable authentication error instead of as the port
/// collision it is. Our `sshd`, meanwhile, exits as soon as its bind fails.
///
/// The order matters, and is not obvious: the check sleeps *before* looking.
/// Asking immediately after spawning always says "still running", because the
/// process has not had time to fail yet — verified by squatting a port and
/// watching an earlier version of this function report success. Every round
/// therefore gives it a moment first, and a successful connect is confirmed by
/// one more round of the same.
pub fn wait_until_listening(child: &mut Child, port: u16) -> bool {
    /// Long enough for a failed bind to have exited — that path is a syscall
    /// error, a log line and `exit`, not real work.
    const SETTLE: Duration = Duration::from_millis(80);

    let alive = |child: &mut Child| matches!(child.try_wait(), Ok(None));

    for _ in 0..60 {
        std::thread::sleep(SETTLE);
        if !alive(child) {
            return false;
        }
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            std::thread::sleep(SETTLE);
            return alive(child);
        }
    }
    false
}

impl Drop for TestSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn run_ok(cmd: &mut Command) {
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("failed to run command");
    assert!(status.success(), "command failed: {cmd:?}");
}

/// A port nothing in this process has been given yet.
///
/// Still not a reservation — no API can hand out a port and hold it at the
/// same time — but it removes the collision that actually happens here, two
/// parallel tests being told to use the same one. Callers that start a server
/// must still cope with losing the port to something outside this process;
/// [`TestSshd::start`] does, by retrying.
pub fn free_port() -> u16 {
    for _ in 0..50 {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("binding an ephemeral port must work")
            .local_addr()
            .expect("a bound listener has a local address")
            .port();
        if claimed_ports().lock().expect("mutex empoisonné").insert(port) {
            return port;
        }
    }
    panic!("impossible d'obtenir un port libre non déjà attribué dans ce processus");
}

pub struct ClientKey {
    dir: PathBuf,
    pub private: PathBuf,
    pub public: PathBuf,
}

impl ClientKey {
    pub fn generate() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "guiterm-test-clientkey-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let private = dir.join("id_ed25519");
        run_ok(
            Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-f"])
                .arg(&private)
                .args(["-N", ""]),
        );
        let public = dir.join("id_ed25519.pub");
        Self {
            dir,
            private,
            public,
        }
    }
}

impl Drop for ClientKey {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn current_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .expect("no USER/LOGNAME in environment")
}

pub fn test_host(sshd: &TestSshd, key: &ClientKey, label: &str) -> termius_core::model::Host {
    let mut host = termius_core::model::Host::new(label, "127.0.0.1", current_username());
    host.port = sshd.port;
    host.auth = termius_core::model::AuthMethod::PrivateKey {
        path: key.private.to_string_lossy().to_string(),
        key_id: None,
    };
    host
}
