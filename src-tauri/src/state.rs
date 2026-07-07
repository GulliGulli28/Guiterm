use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use termius_core::model::{PortForwardId, Workspace};
use termius_core::port_forward::ActiveForward;
use termius_core::sftp::SftpClient;
use termius_core::ssh::{Connection, ShellInput};
use tokio::sync::mpsc;

/// A live interactive shell. `connection` is never read directly, only kept
/// alive: dropping it would tear down the SSH session the shell runs on.
pub struct TerminalSession {
    #[allow(dead_code)]
    pub connection: Connection,
    pub input: mpsc::Sender<ShellInput>,
}

/// One side of an open transfer tab: `client: None` means the local filesystem.
pub struct Pane {
    #[allow(dead_code)]
    pub connection: Option<Connection>,
    pub client: Option<Arc<SftpClient>>,
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

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Workspace>,
    pub terminals: Mutex<HashMap<String, TerminalSession>>,
    pub local_terminals: Mutex<HashMap<String, LocalTerminalSession>>,
    pub panes: Mutex<HashMap<String, Pane>>,
    pub forwards: Mutex<HashMap<PortForwardId, ForwardSession>>,
    /// One cancellation flag per in-flight `upload_file`/`download_file` transfer, keyed by transfer id.
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Command history for local-terminal ghost-text suggestions, most recent last.
    pub local_history: Mutex<Vec<String>>,
    /// Command history for SSH-terminal ghost-text suggestions, shared across all hosts, most recent last.
    pub ssh_history: Mutex<Vec<String>>,
}
