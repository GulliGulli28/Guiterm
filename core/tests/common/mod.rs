//! Shared helpers for integration tests that need a real `sshd` to talk to.
#![allow(dead_code)]
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct TestSshd {
    dir: PathBuf,
    pub port: u16,
    child: Child,
}

impl TestSshd {
    pub fn start(name: &str, client_pubkey_path: &Path) -> Self {
        let dir = std::env::temp_dir().join(format!("gui-termius-test-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let host_key = dir.join("host_key");
        run_ok(Command::new("ssh-keygen").args(["-t", "ed25519", "-f"]).arg(&host_key).args(["-N", ""]));

        let authorized_keys = dir.join("authorized_keys");
        std::fs::copy(client_pubkey_path, &authorized_keys).unwrap();

        let port = free_port();
        let config_path = dir.join("sshd_config");
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

        let child = Command::new("/usr/sbin/sshd")
            .args(["-f"])
            .arg(&config_path)
            .args(["-D", "-e"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sshd - is openssh-server installed?");

        let server = Self { dir, port, child };
        server.wait_until_listening();
        server
    }

    fn wait_until_listening(&self) {
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd on port {} did not start listening in time", self.port);
    }
}

impl Drop for TestSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn run_ok(cmd: &mut Command) {
    let status = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().expect("failed to run command");
    assert!(status.success(), "command failed: {cmd:?}");
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

pub struct ClientKey {
    dir: PathBuf,
    pub private: PathBuf,
    pub public: PathBuf,
}

impl ClientKey {
    pub fn generate() -> Self {
        let dir = std::env::temp_dir().join(format!("gui-termius-test-clientkey-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let private = dir.join("id_ed25519");
        run_ok(Command::new("ssh-keygen").args(["-t", "ed25519", "-f"]).arg(&private).args(["-N", ""]));
        let public = dir.join("id_ed25519.pub");
        Self { dir, private, public }
    }
}

impl Drop for ClientKey {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn current_username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).expect("no USER/LOGNAME in environment")
}

pub fn test_host(sshd: &TestSshd, key: &ClientKey, label: &str) -> termius_core::model::Host {
    let mut host = termius_core::model::Host::new(label, "127.0.0.1", current_username());
    host.port = sshd.port;
    host.auth = termius_core::model::AuthMethod::PrivateKey { path: key.private.to_string_lossy().to_string(), key_id: None };
    host
}
