use crate::state::{AppState, TerminalSession};
use crate::util;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use termius_core::model::HostId;
use termius_core::ssh::{self, ShellInput};
use uuid::Uuid;

#[derive(Serialize, Clone)]
struct TerminalDataEvent {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct TerminalClosedEvent {
    id: String,
}

/// Wraps a value in single quotes, escaping any embedded single quotes.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Connects to `host_id` and starts an interactive shell, emitting its
/// output as `terminal-data` events (base64-encoded) until it closes.
#[tauri::command]
pub async fn connect_terminal(app: AppHandle, state: State<'_, AppState>, host_id: HostId) -> Result<String, String> {
    let workspace = state.workspace.lock().expect("lock poisoned").clone();

    // Collect startup commands before the async SSH calls.
    let startup_cmds: Vec<Vec<u8>> = {
        let mut cmds = Vec::new();
        if let Some(host) = workspace.host(host_id) {
            for ev in &host.env_vars {
                if !ev.key.is_empty() {
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
    };

    let agent_forward = workspace.host(host_id).map(|h| h.agent_forward).unwrap_or(false);
    let connection = ssh::connect(&workspace, host_id).await.map_err(|e| e.to_string())?;
    let shell = ssh::open_shell(&connection, 80, 24, agent_forward).await.map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let ssh::ShellSession { input, mut output } = shell;

    let emit_id = session_id.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            let payload = TerminalDataEvent { id: emit_id.clone(), data: util::encode(&bytes) };
            if app_handle.emit("terminal-data", payload).is_err() {
                break;
            }
        }
        let _ = app_handle.emit("terminal-closed", TerminalClosedEvent { id: emit_id });
    });

    for cmd in startup_cmds {
        let _ = input.send(ShellInput::Data(cmd)).await;
    }

    state.terminals.lock().expect("lock poisoned").insert(session_id.clone(), TerminalSession { connection, input });
    Ok(session_id)
}

fn terminal_input(state: &AppState, session_id: &str) -> Result<tokio::sync::mpsc::Sender<ShellInput>, String> {
    state.terminals.lock().expect("lock poisoned").get(session_id).map(|t| t.input.clone()).ok_or_else(|| "session inconnue".to_string())
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
    state.terminals.lock().expect("lock poisoned").remove(&session_id);
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
        if let Ok(current) = std::env::var("SHELL") {
            if !current.is_empty() && seen.insert(current.clone()) {
                let label = current.rsplit('/').next().unwrap_or(&current);
                shells.push(ShellInfo { id: current.clone(), label: format!("{label} (courant)") });
            }
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
pub async fn open_local_terminal(app: AppHandle, state: State<'_, AppState>, shell: Option<String>) -> Result<String, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    let shell = shell.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(windows) {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });

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
                    let payload = TerminalDataEvent { id: emit_id.clone(), data: util::encode(&buf[..n]) };
                    if app_handle.emit("terminal-data", payload).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app_handle.emit("terminal-closed", TerminalClosedEvent { id: emit_id });
    });

    state.local_terminals.lock().expect("lock poisoned").insert(
        session_id.clone(),
        crate::state::LocalTerminalSession { master: crate::state::SendMasterPty(pair.master), writer },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn write_local_terminal(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    use std::io::Write;
    let bytes = util::decode(&data).map_err(|e| e.to_string())?;
    let mut sessions = state.local_terminals.lock().expect("lock poisoned");
    let session = sessions.get_mut(&session_id).ok_or_else(|| "session inconnue".to_string())?;
    session.writer.write_all(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resize_local_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::PtySize;
    let sessions = state.local_terminals.lock().expect("lock poisoned");
    let session = sessions.get(&session_id).ok_or_else(|| "session inconnue".to_string())?;
    session.master.0.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_local_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.local_terminals.lock().expect("lock poisoned").remove(&session_id);
    Ok(())
}
