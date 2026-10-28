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

/// Un runbook seul, dans son fichier.
///
/// **C'est la forme qui donne son sens au chantier** : une procédure décrit ce
/// qu'il faut faire, pas sur quelles machines, donc elle vaut encore dans le
/// dépôt d'à côté et se relit dans une revue de code. C'est aussi pourquoi la
/// portée d'une étape se dit par tag et par dossier et jamais par identifiant
/// d'hôte (voir `crate::model::RunbookStepScope`) : un fichier qui porterait
/// des UUID locaux ne ciblerait plus rien chez quelqu'un d'autre.
///
/// Rien d'autre n'accompagne le runbook, contrairement à [`HostExport`] qui
/// emporte groupes, snippets et clé : une procédure ne référence aucune autre
/// entité du workspace. C'est une propriété du modèle, pas un raccourci — si
/// une étape venait un jour à référencer un snippet, ce champ manquerait ici.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunbookExport {
    pub export_version: u32,
    pub runbook: crate::model::Runbook,
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
    if !include_key_material
        && let Some(k) = keychain_key.as_mut() {
        k.content = None;
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
    if let Some(key) = export.keychain_key
        && !workspace.keychain.iter().any(|k| k.id == key.id) {
        workspace.keychain.push(key);
    }
    if let Some(icon) = export.custom_icon
        && !workspace.custom_icons.iter().any(|i| i.id == icon.id) {
        workspace.custom_icons.push(icon);
    }

    if let Some(e) = workspace.hosts.iter_mut().find(|h| h.id == export.host.id) {
        *e = export.host;
    } else {
        workspace.hosts.push(export.host);
    }
}

// ─── Aperçu avant import ────────────────────────────────────────────────────

/// Ce qu'un fichier d'export contient : la configuration entière, ou un hôte
/// seul. Les deux s'importent par deux commandes différentes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFileKind {
    Workspace,
    Host,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHost {
    pub id: HostId,
    pub label: String,
    pub address: String,
    pub username: String,
    pub port: u16,
    /// Un hôte de même id existe déjà : la fusion le remplacera.
    pub existing: bool,
}

/// Ce que la fenêtre d'import montre avant qu'on confirme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub kind: ExportFileKind,
    pub hosts: Vec<PreviewHost>,
    pub groups: usize,
    pub snippets: usize,
    pub keys: usize,
    pub port_forwards: usize,
    /// Au moins un hôte porte des snippets ou des variables de démarrage. Ils
    /// sont retirés à l'import sauf demande contraire : c'est ce qui décide si
    /// la fenêtre pose la question.
    pub has_automation: bool,
}

/// Lit un fichier d'export sans rien écrire, pour l'aperçu.
///
/// Le genre se décide sur la clé de premier niveau (`workspace` ou `host`)
/// avant la désérialisation complète : sans ça, un fichier d'hôte mal formé
/// se serait fait refuser avec l'erreur de l'autre format, qui ne lui parle
/// de rien.
pub fn preview(json: &str, current: &Workspace) -> Result<ExportPreview, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Ce fichier n'est pas du JSON lisible : {e}"))?;
    let existing = |id: &HostId| current.hosts.iter().any(|h| &h.id == id);
    let describe = |h: &Host| PreviewHost {
        id: h.id,
        label: h.label.clone(),
        address: h.address.clone(),
        username: h.username.clone(),
        port: h.port,
        existing: existing(&h.id),
    };
    let automated = |h: &Host| !h.startup_snippets.is_empty() || !h.env_vars.is_empty();

    if value.get("workspace").is_some() {
        let file: WorkspaceExport =
            serde_json::from_value(value).map_err(|e| format!("Export de configuration illisible : {e}"))?;
        let w = &file.workspace;
        return Ok(ExportPreview {
            kind: ExportFileKind::Workspace,
            hosts: w.hosts.iter().map(describe).collect(),
            groups: w.groups.len(),
            snippets: w.snippets.len(),
            keys: w.keychain.len(),
            port_forwards: w.port_forwards.len(),
            has_automation: w.hosts.iter().any(automated),
        });
    }
    if value.get("host").is_some() {
        let file: HostExport =
            serde_json::from_value(value).map_err(|e| format!("Export d'hôte illisible : {e}"))?;
        return Ok(ExportPreview {
            kind: ExportFileKind::Host,
            hosts: vec![describe(&file.host)],
            groups: file.groups.len(),
            snippets: file.snippets.len(),
            keys: usize::from(file.keychain_key.is_some()),
            port_forwards: 0,
            has_automation: automated(&file.host),
        });
    }
    Err("Ce fichier n'est pas un export Guiterm : ni configuration, ni hôte.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EnvVar, Host};

    fn workspace_with(hosts: Vec<Host>) -> Workspace {
        Workspace { hosts, ..Workspace::default() }
    }

    #[test]
    fn a_workspace_export_lists_its_hosts_and_marks_the_known_ones() {
        let known = Host::new("web-01", "10.0.0.1", "deploy");
        let fresh = Host::new("db-01", "10.0.0.2", "postgres");
        let exported = workspace_with(vec![known.clone(), fresh.clone()]);
        let json = serde_json::to_string(&make_workspace_export(&exported, false)).unwrap();

        let preview = preview(&json, &workspace_with(vec![known.clone()])).unwrap();
        assert_eq!(preview.kind, ExportFileKind::Workspace);
        assert_eq!(preview.hosts.len(), 2);
        assert!(preview.hosts.iter().find(|h| h.id == known.id).unwrap().existing);
        assert!(!preview.hosts.iter().find(|h| h.id == fresh.id).unwrap().existing);
        assert!(!preview.has_automation);
    }

    #[test]
    fn a_host_export_is_recognised_as_such() {
        let mut host = Host::new("bastion", "bastion.exemple.fr", "jump");
        host.env_vars.push(EnvVar { key: "LANG".into(), value: "fr_FR.UTF-8".into(), ..EnvVar::default() });
        let source = workspace_with(vec![host.clone()]);
        let json = serde_json::to_string(&make_host_export(&source, host.id, false).unwrap()).unwrap();

        let preview = preview(&json, &Workspace::default()).unwrap();
        assert_eq!(preview.kind, ExportFileKind::Host);
        assert_eq!(preview.hosts.len(), 1);
        assert_eq!(preview.hosts[0].label, "bastion");
        assert!(!preview.hosts[0].existing);
        assert!(preview.has_automation, "les variables de démarrage doivent être signalées");
    }

    #[test]
    fn anything_else_is_refused_with_a_message_that_says_why() {
        let err = preview(r#"{"exportVersion":1,"runbook":{}}"#, &Workspace::default()).unwrap_err();
        assert!(err.contains("pas un export Guiterm"), "{err}");
        let err = preview("pas du json", &Workspace::default()).unwrap_err();
        assert!(err.contains("JSON"), "{err}");
    }
}
