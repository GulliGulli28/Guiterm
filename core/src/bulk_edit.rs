//! Applying one edit to many hosts at once.
//!
//! **Why it exists.** An import creates fifty hosts in one go — a whole Azure
//! subscription, an Ansible inventory — and until now changing anything about
//! them afterwards was a fifty-times-one-by-one job. The import panels' batch
//! credentials only ever applied at *creation*: `cloud_inventory::apply_import`
//! is explicit that a re-import must never overwrite what the user decided
//! after the fact. So there was no way to decide something for a group.
//!
//! **The whole design is "only what was asked".** Writing across fifty hosts is
//! not something anyone can undo by hand, so this never carries a form: it
//! carries a set of *fields that were explicitly chosen*, and touches nothing
//! else. A field left alone is `None`, and `None` means "do not write", never
//! "write the default" — the distinction that separates a bulk edit from a bulk
//! overwrite.

use crate::model::{AuthMethod, GroupId, Host, HostId, Workspace};
use serde::{Deserialize, Deserializer};

/// Distinguishes an absent field from one explicitly set to `null`.
///
/// Serde collapses both to `None` on a plain `Option`, which would make
/// "leave the group alone" and "move out of every group" indistinguishable —
/// and silently turn the first into the second. Written here rather than
/// pulled from `serde_with`, which this workspace doesn't depend on: it is
/// four lines, and a dependency for four lines is a dependency to keep
/// updated.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    // Reached only when the key is present; `serde(default)` covers its
    // absence. So "present" is exactly what wrapping in `Some` records.
    Option::deserialize(deserializer).map(Some)
}

/// What to change, and on which hosts.
///
/// Every field is optional and absent means untouched. `Option<Option<T>>`
/// where the value is itself nullable — the group — because "leave the group
/// alone" and "move to no group at all" are different instructions and both
/// have to be expressible.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkEdit {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// `Some(None)` moves the hosts out of every group.
    #[serde(default, deserialize_with = "double_option")]
    pub group_id: Option<Option<GroupId>>,
    #[serde(default)]
    pub auth: Option<AuthMethod>,
    /// Tags to add. Never a replacement: tags come from imports as well as from
    /// people, and replacing the list would silently drop the provider labels
    /// an import wrote — which is what `target tag:` runs on.
    #[serde(default)]
    pub add_tags: Vec<String>,
    /// Tags to remove, matched exactly.
    #[serde(default)]
    pub remove_tags: Vec<String>,
}

impl BulkEdit {
    /// Whether this would change anything at all.
    ///
    /// The panel refuses an empty edit rather than reporting "50 hosts
    /// updated" after doing nothing.
    pub fn is_empty(&self) -> bool {
        self.username.is_none()
            && self.port.is_none()
            && self.group_id.is_none()
            && self.auth.is_none()
            && self.add_tags.is_empty()
            && self.remove_tags.is_empty()
    }

    /// A short description of what will be written, for the confirmation.
    ///
    /// Built from the same fields the apply reads, so the sentence shown and
    /// the write performed can't drift apart.
    pub fn summary(&self) -> Vec<String> {
        let mut parts = Vec::new();
        if let Some(username) = &self.username {
            parts.push(format!("utilisateur → {username}"));
        }
        if let Some(port) = self.port {
            parts.push(format!("port → {port}"));
        }
        match &self.group_id {
            Some(Some(_)) => parts.push("groupe → (nouveau)".to_string()),
            Some(None) => parts.push("groupe → aucun".to_string()),
            None => {}
        }
        if self.auth.is_some() {
            parts.push("authentification".to_string());
        }
        if !self.add_tags.is_empty() {
            parts.push(format!("+ tags {}", self.add_tags.join(", ")));
        }
        if !self.remove_tags.is_empty() {
            parts.push(format!("− tags {}", self.remove_tags.join(", ")));
        }
        parts
    }
}

/// Applies `edit` to every host in `host_ids`, and reports which were changed.
///
/// Hosts are matched by id, so a selection made against a stale list simply
/// skips what no longer exists rather than editing the wrong machine.
pub fn apply(workspace: &mut Workspace, host_ids: &[HostId], edit: &BulkEdit) -> Vec<HostId> {
    let mut changed = Vec::new();
    for host in workspace.hosts.iter_mut() {
        if !host_ids.contains(&host.id) {
            continue;
        }
        apply_to(host, edit);
        changed.push(host.id);
    }
    changed
}

fn apply_to(host: &mut Host, edit: &BulkEdit) {
    if let Some(username) = &edit.username {
        host.username = username.clone();
    }
    if let Some(port) = edit.port {
        host.port = port;
    }
    if let Some(group_id) = &edit.group_id {
        host.group_id = *group_id;
    }
    if let Some(auth) = &edit.auth {
        host.auth = auth.clone();
    }
    for tag in &edit.add_tags {
        if !host.tags.iter().any(|existing| existing == tag) {
            host.tags.push(tag.clone());
        }
    }
    if !edit.remove_tags.is_empty() {
        host.tags.retain(|tag| !edit.remove_tags.contains(tag));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_with(labels: &[&str]) -> Workspace {
        Workspace {
            hosts: labels
                .iter()
                .map(|label| Host::new(*label, "10.0.0.1", "root"))
                .collect(),
            ..Default::default()
        }
    }

    /// The rule the whole module exists for: a field nobody chose is never
    /// written. Without it, a bulk edit is a bulk overwrite — and fifty hosts
    /// is not something anyone puts back by hand.
    #[test]
    fn a_field_that_was_not_chosen_is_left_alone() {
        let mut workspace = workspace_with(&["web-1"]);
        workspace.hosts[0].port = 2222;
        workspace.hosts[0].tags = vec!["prod".to_string()];
        workspace.hosts[0].group_id = None;
        let ids: Vec<HostId> = workspace.hosts.iter().map(|h| h.id).collect();

        // Only the username is chosen.
        let edit = BulkEdit { username: Some("ubuntu".to_string()), ..Default::default() };
        apply(&mut workspace, &ids, &edit);

        let host = &workspace.hosts[0];
        assert_eq!(host.username, "ubuntu");
        assert_eq!(host.port, 2222, "le port n'était pas coché");
        assert_eq!(host.tags, vec!["prod".to_string()], "les tags non plus");
    }

    #[test]
    fn only_the_selected_hosts_are_touched() {
        let mut workspace = workspace_with(&["web-1", "web-2", "db-1"]);
        let target = workspace.hosts[1].id;

        let edit = BulkEdit { username: Some("deploy".to_string()), ..Default::default() };
        let changed = apply(&mut workspace, &[target], &edit);

        assert_eq!(changed, vec![target]);
        assert_eq!(workspace.hosts[0].username, "root");
        assert_eq!(workspace.hosts[1].username, "deploy");
        assert_eq!(workspace.hosts[2].username, "root");
    }

    /// "Leave the group alone" and "move out of every group" are different
    /// instructions, and a plain `Option<GroupId>` can only express one of
    /// them — hence the double option.
    #[test]
    fn clearing_a_group_differs_from_not_touching_it() {
        let group = GroupId::new_v4();
        let mut workspace = workspace_with(&["web-1"]);
        workspace.hosts[0].group_id = Some(group);
        let ids: Vec<HostId> = workspace.hosts.iter().map(|h| h.id).collect();

        apply(&mut workspace, &ids, &BulkEdit::default());
        assert_eq!(workspace.hosts[0].group_id, Some(group), "non coché = intact");

        apply(&mut workspace, &ids, &BulkEdit { group_id: Some(None), ..Default::default() });
        assert_eq!(workspace.hosts[0].group_id, None, "coché à « aucun » = vidé");
    }

    /// Tags are added and removed, never replaced: an import writes the
    /// provider's own labels, and `target tag:` in the adaptive language runs
    /// on them. Replacing the list would drop them without a word.
    #[test]
    fn tags_are_merged_rather_than_replaced() {
        let mut workspace = workspace_with(&["web-1"]);
        workspace.hosts[0].tags = vec!["env=prod".to_string(), "role=web".to_string()];
        let ids: Vec<HostId> = workspace.hosts.iter().map(|h| h.id).collect();

        let edit = BulkEdit {
            add_tags: vec!["astreinte".to_string(), "env=prod".to_string()],
            remove_tags: vec!["role=web".to_string()],
            ..Default::default()
        };
        apply(&mut workspace, &ids, &edit);

        assert_eq!(
            workspace.hosts[0].tags,
            vec!["env=prod".to_string(), "astreinte".to_string()],
            "un tag déjà présent n'est pas dupliqué, et seul le tag retiré part"
        );
    }

    #[test]
    fn an_edit_that_changes_nothing_is_recognisable() {
        assert!(BulkEdit::default().is_empty());
        assert!(!BulkEdit { port: Some(22), ..Default::default() }.is_empty());
        assert!(!BulkEdit { add_tags: vec!["x".to_string()], ..Default::default() }.is_empty());
        // Clearing the group is a real change, even though the value is None.
        assert!(!BulkEdit { group_id: Some(None), ..Default::default() }.is_empty());
    }

    /// The confirmation is built from the same fields the apply reads, so what
    /// is shown and what is written cannot drift apart.
    #[test]
    fn the_summary_names_every_chosen_field() {
        let edit = BulkEdit {
            username: Some("ubuntu".to_string()),
            port: Some(2222),
            group_id: Some(None),
            add_tags: vec!["astreinte".to_string()],
            ..Default::default()
        };
        let summary = edit.summary().join(" · ");
        assert!(summary.contains("ubuntu"));
        assert!(summary.contains("2222"));
        assert!(summary.contains("aucun"));
        assert!(summary.contains("astreinte"));
        assert_eq!(BulkEdit::default().summary().len(), 0);
    }

    /// A selection made against a list that has since changed must skip what
    /// is gone, never fall through to another machine.
    #[test]
    fn an_id_that_no_longer_exists_is_skipped() {
        let mut workspace = workspace_with(&["web-1"]);
        let ghost = HostId::new_v4();
        let changed = apply(
            &mut workspace,
            &[ghost],
            &BulkEdit { username: Some("nobody".to_string()), ..Default::default() },
        );
        assert!(changed.is_empty());
        assert_eq!(workspace.hosts[0].username, "root");
    }

    /// The wire shape the frontend sends. A Rust→Rust roundtrip would agree
    /// with itself even if the casing were wrong on both sides — the trap this
    /// repo has hit six times — so the JSON is written by hand.
    #[test]
    fn the_edit_is_read_from_hand_written_camel_case_json() {
        let edit: BulkEdit = serde_json::from_str(
            r#"{"username":"ubuntu","port":2222,"groupId":null,"addTags":["a"],"removeTags":["b"]}"#,
        )
        .unwrap();
        assert_eq!(edit.username.as_deref(), Some("ubuntu"));
        assert_eq!(edit.port, Some(2222));
        assert_eq!(edit.group_id, Some(None), "groupId: null = vider le groupe");
        assert_eq!(edit.add_tags, vec!["a".to_string()]);
        assert_eq!(edit.remove_tags, vec!["b".to_string()]);

        // An absent `groupId` is "leave it alone", which is not the same thing.
        let untouched: BulkEdit = serde_json::from_str(r#"{"username":"x"}"#).unwrap();
        assert_eq!(untouched.group_id, None);
    }
}
