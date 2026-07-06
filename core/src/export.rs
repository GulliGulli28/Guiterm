use serde::{Deserialize, Serialize};
use crate::model::{CustomIcon, Group, GroupId, Host, HostId, PrivateKey, Snippet, Workspace};

pub const EXPORT_VERSION: u32 = 1;

// ─── File envelope types ────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExport {
    pub export_version: u32,
    pub workspace: Workspace,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostExport {
    pub export_version: u32,
    pub host: Host,
    /// Full ancestor group chain so the host can be placed in the correct folder.
    pub groups: Vec<Group>,
    /// Startup snippets referenced by this host.
    pub snippets: Vec<Snippet>,
    /// Keychain key used by this host (passphrase never included).
    pub keychain_key: Option<PrivateKey>,
    /// Custom icon assigned to the host.
    pub custom_icon: Option<CustomIcon>,
    /// Bastion hosts listed in jump_via (informational — not auto-imported).
    pub jump_via_hosts: Vec<Host>,
}

// ─── Build exports ──────────────────────────────────────────────────────────

/// Builds the exportable workspace. `include_key_material` controls whether the PEM
/// content cached on each keychain key is included: that content is the actual SSH
/// private key, so callers should only pass `true` after the user has explicitly
/// opted in (e.g. to move their setup to another machine), not by default.
pub fn make_workspace_export(workspace: &Workspace, include_key_material: bool) -> WorkspaceExport {
    let mut workspace = workspace.clone();
    if !include_key_material {
        for key in &mut workspace.keychain {
            key.content = None;
        }
    }
    WorkspaceExport { export_version: EXPORT_VERSION, workspace }
}

/// See [`make_workspace_export`] for what `include_key_material` controls.
pub fn make_host_export(workspace: &Workspace, host_id: HostId, include_key_material: bool) -> Option<HostExport> {
    let host = workspace.host(host_id)?.clone();

    let groups = collect_group_chain(workspace, host.group_id);

    let snippets = host.startup_snippets.iter()
        .filter_map(|&sid| workspace.snippets.iter().find(|s| s.id == sid))
        .cloned()
        .collect();

    let mut keychain_key = if let crate::model::AuthMethod::PrivateKey { key_id: Some(kid), .. } = &host.auth {
        workspace.keychain.iter().find(|k| k.id == *kid).cloned()
    } else {
        None
    };
    if !include_key_material {
        if let Some(k) = keychain_key.as_mut() {
            k.content = None;
        }
    }

    let custom_icon = host.icon.as_deref()
        .and_then(|icon_id| workspace.custom_icons.iter().find(|i| i.id == icon_id))
        .cloned();

    let jump_via_hosts = host.jump_via.iter()
        .filter_map(|&jid| workspace.host(jid))
        .cloned()
        .collect();

    Some(HostExport { export_version: EXPORT_VERSION, host, groups, snippets, keychain_key, custom_icon, jump_via_hosts })
}

fn collect_group_chain(workspace: &Workspace, start: Option<GroupId>) -> Vec<Group> {
    let mut chain = Vec::new();
    let mut current = start;
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) { break; }
        if let Some(g) = workspace.groups.iter().find(|g| g.id == id) {
            chain.push(g.clone());
            current = g.parent_id;
        } else {
            break;
        }
    }
    chain.reverse();
    chain
}

// ─── Import / merge ─────────────────────────────────────────────────────────

/// Merge `imported` into `current`: items with matching IDs are replaced,
/// new IDs are appended.
pub fn merge_workspace(current: &mut Workspace, imported: Workspace) {
    merge_by_id(&mut current.groups, imported.groups, |a, b| a.id == b.id);
    merge_by_id(&mut current.hosts, imported.hosts, |a, b| a.id == b.id);
    merge_by_id(&mut current.snippets, imported.snippets, |a, b| a.id == b.id);
    merge_by_id(&mut current.port_forwards, imported.port_forwards, |a, b| a.id == b.id);
    merge_by_id(&mut current.keychain, imported.keychain, |a, b| a.id == b.id);
    for icon in imported.custom_icons {
        if let Some(e) = current.custom_icons.iter_mut().find(|i| i.id == icon.id) {
            *e = icon;
        } else {
            current.custom_icons.push(icon);
        }
    }
}

fn merge_by_id<T: Clone>(current: &mut Vec<T>, incoming: Vec<T>, eq: impl Fn(&T, &T) -> bool) {
    for item in incoming {
        if let Some(e) = current.iter_mut().find(|e| eq(e, &item)) {
            *e = item;
        } else {
            current.push(item);
        }
    }
}

/// Import a single host export into the workspace (add-or-replace by ID).
pub fn import_host(workspace: &mut Workspace, export: HostExport) {
    merge_by_id(&mut workspace.groups, export.groups, |a, b| a.id == b.id);

    for snippet in export.snippets {
        if !workspace.snippets.iter().any(|s| s.id == snippet.id) {
            workspace.snippets.push(snippet);
        }
    }
    if let Some(key) = export.keychain_key {
        if !workspace.keychain.iter().any(|k| k.id == key.id) {
            workspace.keychain.push(key);
        }
    }
    if let Some(icon) = export.custom_icon {
        if !workspace.custom_icons.iter().any(|i| i.id == icon.id) {
            workspace.custom_icons.push(icon);
        }
    }

    if let Some(e) = workspace.hosts.iter_mut().find(|h| h.id == export.host.id) {
        *e = export.host;
    } else {
        workspace.hosts.push(export.host);
    }
}
