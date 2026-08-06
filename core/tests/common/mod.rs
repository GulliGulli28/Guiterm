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
        Self::start_inner(name, Some(client_pubkey_path), None)
    }

    /// An `sshd` that trusts a CA instead of listing keys, with an **empty**
    /// `authorized_keys`.
    ///
    /// The emptiness is the whole point, and is easy to get wrong: leave the
    /// client's public key in there and the connection succeeds on the key
    /// alone, so a certificate test would pass just as well with the
    /// certificate code deleted. This is the only configuration in which
    /// authenticating proves the certificate was used.
    pub fn start_trusting_ca(name: &str, ca_pubkey_path: &Path) -> Self {
        Self::start_inner(name, None, Some(ca_pubkey_path))
    }

    fn start_inner(name: &str, client_pubkey_path: Option<&Path>, ca_pubkey_path: Option<&Path>) -> Self {
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
        match client_pubkey_path {
            Some(path) => std::fs::copy(path, &authorized_keys).map(|_| ()).unwrap(),
            // Created empty rather than left absent: sshd is happy either way,
            // but an existing empty file makes "no key is trusted here"
            // explicit to anyone reading the temp directory during a failure.
            None => std::fs::write(&authorized_keys, "").unwrap(),
        }

        let trusted_ca = ca_pubkey_path.map(|path| {
            let dest = dir.join("trusted_ca.pub");
            std::fs::copy(path, &dest).unwrap();
            dest
        });

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
            if let Some(ca) = &trusted_ca {
                writeln!(config, "TrustedUserCAKeys {}", ca.display()).unwrap();
            }

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
        cert_path: None,
    };
    host
}

/// A throwaway SSH certificate authority, for the `TrustedUserCAKeys` tests.
pub struct TestCa {
    dir: PathBuf,
    private: PathBuf,
    pub public: PathBuf,
}

impl TestCa {
    pub fn generate() -> Self {
        let dir = std::env::temp_dir().join(format!("guiterm-test-ca-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let private = dir.join("ca");
        run_ok(
            Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-f"])
                .arg(&private)
                .args(["-N", "", "-C", "guiterm-test-ca"]),
        );
        let public = dir.join("ca.pub");
        Self { dir, private, public }
    }

    /// Signs `key`, returning the path of the certificate `ssh-keygen` writes.
    ///
    /// `validity` is `ssh-keygen -V` syntax: `"+1h"` for a usable certificate,
    /// an explicit past window like `"20200101000000:20200102000000"` for one
    /// that has already expired.
    ///
    /// The principal is the current user, because that is the account the test
    /// logs into — a certificate signed for anyone else is refused by sshd,
    /// which would make an expiry test pass for the wrong reason.
    pub fn sign(&self, key: &ClientKey, validity: &str) -> PathBuf {
        run_ok(
            Command::new("ssh-keygen")
                .arg("-s")
                .arg(&self.private)
                .args(["-I", "guiterm-test"])
                .args(["-n", &current_username()])
                .args(["-V", validity])
                .arg(&key.public),
        );
        // `ssh-keygen -s` writes `<pubkey minus .pub>-cert.pub`.
        key.private.with_file_name(format!(
            "{}-cert.pub",
            key.private.file_name().unwrap().to_string_lossy()
        ))
    }
}

impl Drop for TestCa {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
