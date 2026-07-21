use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use termius_core::model::{PortForwardId, Workspace};
use termius_core::port_forward::ActiveForward;
use termius_core::sftp::RemoteFileClient;
use termius_core::sql::SqlSession;
use termius_core::ssh::{Connection, ShellInput};
use tokio::sync::mpsc;

/// Which backend a [`TerminalSession`] actually runs over. Only `Ssh` needs
/// to retain anything beyond the input channel: dropping the `Connection`
/// would tear down the SSH session the shell runs on. A Docker exec or K8s
/// exec session owns its resources entirely inside the task spawned by
/// `termius_core::docker::open_exec`/`termius_core::k8s::open_exec`, so
/// there's nothing extra to keep alive.
pub enum TerminalBackend {
    Ssh(#[allow(dead_code)] Connection),
    Docker,
    K8s,
}

/// A live interactive shell (SSH, Docker exec, or K8s exec), bridged onto
/// the same plain byte-stream channels regardless of backend.
pub struct TerminalSession {
    #[allow(dead_code)]
    pub backend: TerminalBackend,
    pub input: mpsc::Sender<ShellInput>,
}

/// One side of an open transfer tab: `client: None` means the local
/// filesystem, `Some` an SFTP (SSH), Docker-exec, or K8s-exec pane — see
/// `termius_core::sftp::RemoteFileClient`. `connection` only ever holds
/// something for the SFTP case (keeping the SSH session the SFTP subsystem
/// channel rides on alive) — a Docker pane's `bollard::Docker`/K8s pane's
/// `kube::Client` handle already keeps everything it needs alive internally
/// (including, when tunnelled over SSH, the underlying `Connection` — see
/// `termius_core::docker::connect_via_ssh`'s doc comment), so `None` there
/// isn't a leak.
pub struct Pane {
    #[allow(dead_code)]
    pub connection: Option<Connection>,
    pub client: Option<Arc<dyn RemoteFileClient>>,
}

pub struct ForwardSession {
    pub connection: Arc<Connection>,
    pub active: ActiveForward,
}

/// Newtype that asserts Send+Sync for the PTY master.
/// portable-pty 0.8 does not mark MasterPty: Send even though the
/// underlying fd is safe to use from any thread (guarded by our Mutex).
pub struct SendMasterPty(pub Box<dyn portable_pty::MasterPty>);
unsafe impl Send for SendMasterPty {}
unsafe impl Sync for SendMasterPty {}

pub struct LocalTerminalSession {
    pub master: SendMasterPty,
    pub writer: Box<dyn std::io::Write + Send>,
}

/// A live embedded-RDP session — see `commands::rdp_view` and CLAUDE.md's
/// "Pourquoi un processus RDP séparé" section. `child` is kept around solely
/// so `close_rdp_view` can kill the sidecar process; the actual frame data
/// flows to the frontend via `rdp-view-*` events, not through this struct.
pub struct RdpViewSession {
    pub child: tauri_plugin_shell::process::CommandChild,
}

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Workspace>,
    pub terminals: Mutex<HashMap<String, TerminalSession>>,
    pub local_terminals: Mutex<HashMap<String, LocalTerminalSession>>,
    pub panes: Mutex<HashMap<String, Pane>>,
    pub forwards: Mutex<HashMap<PortForwardId, ForwardSession>>,
    pub rdp_views: Mutex<HashMap<String, RdpViewSession>>,
    /// Live SQL connections (pool + tunnel, if tunnelled), keyed by a
    /// generated session id the frontend passes back on every subsequent
    /// call — same "opaque id → live resource" shape as `panes`.
    pub sql_sessions: Mutex<HashMap<String, SqlSession>>,
    /// One cancellation flag per in-flight `upload_file`/`download_file` transfer, keyed by transfer id.
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Command history for local-terminal ghost-text suggestions, most recent last.
    pub local_history: Mutex<Vec<String>>,
    /// Command history for SSH-terminal ghost-text suggestions, shared across all hosts, most recent last.
    pub ssh_history: Mutex<Vec<String>>,
    /// Past fleet runs (audit trail), newest first — persisted to `fleet_history.json`.
    pub fleet_history: Mutex<Vec<termius_core::fleet_history::FleetRun>>,
}
