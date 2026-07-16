use termius_core::sync_ext::MutexExt;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;
use termius_core::model::{
    AuthMethod, CustomIcon, EnvVar, Group, GroupId, Host, HostId, HostKind, KeyId, PortForward,
    PortForwardId, PrivateKey, Snippet, SnippetId, Workspace,
};
use termius_core::store;
use termius_core::vault::{self, SecretKind};

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> Workspace {
    state.workspace.lock_recover().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHostInput {
    pub id: Option<HostId>,
    pub label: String,
    #[serde(default)]
    pub kind: HostKind,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub docker_via_host_id: Option<HostId>,
    pub jump_via: Vec<HostId>,
    pub group_id: Option<GroupId>,
    pub tags: Vec<String>,
    pub startup_snippets: Vec<SnippetId>,
    pub env_vars: Vec<EnvVar>,
    pub icon: Option<String>,
    /// Plaintext password or key passphrase, stored in the OS keychain — never persisted in workspace.json.
    pub secret: Option<String>,
    #[serde(default)]
    pub keepalive_interval_secs: Option<u32>,
    #[serde(default)]
    pub agent_forward: bool,
}

fn persist(workspace: &Workspace) -> Result<(), String> {
    store::save(workspace).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_host(state: State<'_, AppState>, input: SaveHostInput) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();

    let host_id = match input.id {
        Some(id) => {
            if let Some(host) = workspace.hosts.iter_mut().find(|h| h.id == id) {
                host.label = input.label;
                host.kind = input.kind;
                host.address = input.address;
                host.port = input.port;
                host.username = input.username;
                host.auth = input.auth.clone();
                host.docker_via_host_id = input.docker_via_host_id;
                host.jump_via = input.jump_via;
                host.group_id = input.group_id;
                host.tags = input.tags;
                host.startup_snippets = input.startup_snippets;
                host.env_vars = input.env_vars;
                host.icon = input.icon.clone();
                host.keepalive_interval_secs = input.keepalive_interval_secs;
                host.agent_forward = input.agent_forward;
            }
            id
        }
        None => {
            let mut host = Host::new(input.label, input.address, input.username);
            host.kind = input.kind;
            host.port = input.port;
            host.auth = input.auth.clone();
            host.docker_via_host_id = input.docker_via_host_id;
            host.jump_via = input.jump_via;
            host.group_id = input.group_id;
            host.tags = input.tags;
            host.startup_snippets = input.startup_snippets;
            host.env_vars = input.env_vars;
            host.icon = input.icon.clone();
            host.keepalive_interval_secs = input.keepalive_interval_secs;
            host.agent_forward = input.agent_forward;
            let id = host.id;
            workspace.hosts.push(host);
            id
        }
    };

    // Clean up whichever per-host secret slot no longer applies to the (possibly
    // just-changed) auth method, so e.g. switching Password -> Agent doesn't leave
    // a stale password behind in the OS keychain indefinitely.
    match &input.auth {
        AuthMethod::Password => {
            let _ = vault::delete(host_id, SecretKind::KeyPassphrase);
        }
        AuthMethod::PrivateKey { key_id: None, .. } => {
            let _ = vault::delete(host_id, SecretKind::Password);
        }
        AuthMethod::PrivateKey {
            key_id: Some(_), ..
        }
        | AuthMethod::Agent => {
            let _ = vault::delete(host_id, SecretKind::Password);
            let _ = vault::delete(host_id, SecretKind::KeyPassphrase);
        }
    }

    if let Some(secret) = input.secret.filter(|s| !s.is_empty()) {
        match &input.auth {
            AuthMethod::Password => {
                let _ = vault::store(host_id, SecretKind::Password, &secret);
            }
            // Only store the passphrase per-host when no keychain key is involved;
            // keychain keys have their own passphrase stored under key_id.
            AuthMethod::PrivateKey { key_id: None, .. } => {
                let _ = vault::store(host_id, SecretKind::KeyPassphrase, &secret);
            }
            _ => {}
        }
    }

    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn add_private_key(
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Impossible de lire la clé «{}» : {}", path, e))?;
    let id = KeyId::new_v4();
    // When the master vault is unlocked, the key content is stored encrypted
    // there instead of in cleartext in workspace.json.
    let in_vault = vault::is_unlocked();
    if in_vault {
        vault::store_key_content(id, &content).map_err(|e| e.to_string())?;
    }
    let key = PrivateKey {
        id,
        name,
        path,
        content: if in_vault { None } else { Some(content) },
    };
    if let Some(pp) = passphrase.filter(|s| !s.is_empty()) {
        let _ = vault::store(key.id, vault::SecretKind::KeyPassphrase, &pp);
    }
    workspace.keychain.push(key);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_private_key(state: State<'_, AppState>, key_id: KeyId) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.keychain.retain(|k| k.id != key_id);
    let _ = vault::delete(key_id, vault::SecretKind::KeyPassphrase);
    let _ = vault::delete_key_content(key_id);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn rename_private_key(
    state: State<'_, AppState>,
    key_id: KeyId,
    name: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Le nom ne peut pas être vide".to_string());
    }
    if let Some(key) = workspace.keychain.iter_mut().find(|k| k.id == key_id) {
        key.name = name;
    }
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn add_custom_icon(
    state: State<'_, AppState>,
    name: String,
    data_url: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let id = uuid::Uuid::new_v4().to_string();
    workspace
        .custom_icons
        .push(CustomIcon { id, name, data_url });
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_custom_icon(
    state: State<'_, AppState>,
    icon_id: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    for host in &mut workspace.hosts {
        if host.icon.as_deref() == Some(&icon_id) {
            host.icon = None;
        }
    }
    for group in &mut workspace.groups {
        if group.icon.as_deref() == Some(&icon_id) {
            group.icon = None;
        }
    }
    workspace.custom_icons.retain(|i| i.id != icon_id);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn read_icon_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("L'image doit faire moins de 2 Mo".to_string());
    }
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub async fn check_host_status(
    state: State<'_, AppState>,
    host_id: HostId,
) -> Result<bool, String> {
    let workspace = state.workspace.lock_recover().clone();
    Ok(termius_core::ssh::probe(&workspace, host_id).await)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppState>, host_id: HostId) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.hosts.retain(|h| h.id != host_id);
    for host in &mut workspace.hosts {
        host.jump_via.retain(|&jid| jid != host_id);
    }
    let _ = vault::delete(host_id, SecretKind::Password);
    let _ = vault::delete(host_id, SecretKind::KeyPassphrase);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGroupInput {
    pub id: Option<GroupId>,
    pub name: String,
    pub parent_id: Option<GroupId>,
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Whether setting `group_id`'s parent to `new_parent_id` would create a cycle
/// (a group can't end up being its own ancestor).
fn would_create_group_cycle(
    workspace: &Workspace,
    group_id: GroupId,
    new_parent_id: Option<GroupId>,
) -> bool {
    let mut current = new_parent_id;
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if id == group_id || !seen.insert(id) {
            return true;
        }
        current = workspace
            .groups
            .iter()
            .find(|g| g.id == id)
            .and_then(|g| g.parent_id);
    }
    false
}

#[tauri::command]
pub fn save_group(state: State<'_, AppState>, input: SaveGroupInput) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    match input.id {
        Some(id) => {
            if would_create_group_cycle(&workspace, id, input.parent_id) {
                return Err("un dossier ne peut pas être son propre parent".to_string());
            }
            if let Some(group) = workspace.groups.iter_mut().find(|g| g.id == id) {
                group.name = input.name;
                group.parent_id = input.parent_id;
                group.icon = input.icon.clone();
                group.color = input.color.clone();
            }
        }
        None => workspace.groups.push(Group {
            id: GroupId::new_v4(),
            name: input.name,
            parent_id: input.parent_id,
            icon: input.icon,
            color: input.color,
        }),
    }
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, group_id: GroupId) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    let parent_id = workspace
        .groups
        .iter()
        .find(|g| g.id == group_id)
        .and_then(|g| g.parent_id);
    // Re-parent child groups and hosts up to the deleted group's parent instead
    // of leaving them dangling on a removed group.
    for group in &mut workspace.groups {
        if group.parent_id == Some(group_id) {
            group.parent_id = parent_id;
        }
    }
    for host in &mut workspace.hosts {
        if host.group_id == Some(group_id) {
            host.group_id = parent_id;
        }
    }
    workspace.groups.retain(|g| g.id != group_id);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn add_snippet(
    state: State<'_, AppState>,
    name: String,
    command: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.snippets.push(Snippet {
        id: SnippetId::new_v4(),
        name,
        command,
        tags: Vec::new(),
        adaptive: false,
    });
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn update_snippet(
    state: State<'_, AppState>,
    snippet_id: SnippetId,
    name: String,
    command: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    if let Some(snippet) = workspace.snippets.iter_mut().find(|s| s.id == snippet_id) {
        snippet.name = name;
        snippet.command = command;
    }
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn delete_snippet(
    state: State<'_, AppState>,
    snippet_id: SnippetId,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.snippets.retain(|s| s.id != snippet_id);
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddForwardInput {
    pub host_id: HostId,
    pub kind: termius_core::model::PortForwardKind,
    pub bind_address: String,
    pub bind_port: u16,
    pub dest_address: String,
    pub dest_port: u16,
}

#[tauri::command]
pub fn add_forward(
    state: State<'_, AppState>,
    input: AddForwardInput,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    workspace.port_forwards.push(PortForward {
        id: PortForwardId::new_v4(),
        host_id: input.host_id,
        kind: input.kind,
        bind_address: input.bind_address,
        bind_port: input.bind_port,
        dest_address: input.dest_address,
        dest_port: input.dest_port,
    });
    persist(&workspace)?;
    Ok(workspace.clone())
}

#[tauri::command]
pub async fn delete_forward(
    state: State<'_, AppState>,
    forward_id: PortForwardId,
) -> Result<Workspace, String> {
    let session = state
        .forwards
        .lock_recover()
        .remove(&forward_id);
    if let Some(session) = session {
        session.active.stop(&session.connection).await;
    }
    let mut workspace = state.workspace.lock_recover();
    workspace.port_forwards.retain(|f| f.id != forward_id);
    persist(&workspace)?;
    Ok(workspace.clone())
}
