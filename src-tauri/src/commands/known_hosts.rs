use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use termius_core::known_hosts;
use termius_core::model::{GroupId, Host, Workspace};
use termius_core::ssh_config;
use termius_core::store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub identity: String,
    pub label: String,
    pub public_key: String,
}

#[tauri::command]
pub fn list_known_hosts() -> Vec<KnownHostEntry> {
    known_hosts::list()
        .into_iter()
        .map(|(identity, label, public_key)| KnownHostEntry { identity, label, public_key })
        .collect()
}

#[tauri::command]
pub fn revoke_known_host(identity: String) -> Result<(), String> {
    known_hosts::remove(&identity).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHostDto {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

impl From<ssh_config::SshConfigHost> for SshConfigHostDto {
    fn from(h: ssh_config::SshConfigHost) -> Self {
        Self {
            alias: h.alias,
            hostname: h.hostname,
            user: h.user,
            port: h.port,
            identity_file: h.identity_file,
            proxy_jump: h.proxy_jump,
        }
    }
}

/// Previews the `Host` blocks found in `path` (or `~/.ssh/config` if omitted).
/// Returns an empty list rather than an error when the file simply doesn't exist.
#[tauri::command]
pub fn preview_ssh_config_import(path: Option<String>) -> Result<Vec<SshConfigHostDto>, String> {
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => ssh_config::default_path().ok_or_else(|| "impossible de déterminer le dossier personnel".to_string())?,
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    ssh_config::parse(&path).map(|hosts| hosts.into_iter().map(Into::into).collect()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub group_id: Option<GroupId>,
}

fn persist(workspace: &Workspace) -> Result<(), String> {
    store::save(workspace).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_ssh_config_hosts(state: State<'_, AppState>, selections: Vec<ImportSelection>) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock().expect("lock poisoned");
    for sel in selections {
        let mut host = Host::new(sel.alias, sel.hostname, sel.user);
        host.port = sel.port;
        host.group_id = sel.group_id;
        workspace.hosts.push(host);
    }
    persist(&workspace)?;
    Ok(workspace.clone())
}
