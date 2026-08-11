//! What Azure and GCP imports have in common: the shape of an instance, and
//! what ticking one does to the workspace.
//!
//! **Why this one *is* shared, when `ansible_inventory` refused to share with
//! `aws_inventory`.** That refusal was about the *matching rule*, and it was
//! right: EC2 hosts imported before provenance existed carry no
//! [`crate::model::HostSource`], so making AWS match on it would duplicate
//! every instance already in a user's workspace. Azure and GCP have no such
//! history — no host anywhere carries `kind: "azure"` or `kind: "gcp"` yet —
//! and both providers hand out an identifier that is immutable and globally
//! unique for the life of the machine. So the two really do match on the same
//! thing, and the body below is genuinely one function rather than an `if
//! provider` wearing a disguise.
//!
//! The provider-specific half — which CLI to run and how to read its JSON —
//! lives in [`crate::azure_inventory`] and [`crate::gcp_inventory`].

use crate::cloud_cli::Provider;
use crate::model::{AuthMethod, GroupId, Host, HostSource, Workspace};
use serde::{Deserialize, Serialize};

/// One cloud instance, as an import panel needs to show it.
///
/// Deliberately flat and provider-neutral: both panels render the same table,
/// and a variant per provider would push the difference into the frontend
/// where `assertNever` can't help.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInstance {
    /// The provider's own resource identifier, and **the identity a re-import
    /// matches on**: the full ARM resource id on Azure, the numeric instance
    /// id on GCP. Neither changes when a machine is renamed, restarted,
    /// re-addressed or moved between zones — unlike the name and the address,
    /// which is precisely why neither of those is used (see
    /// `ansible_inventory`'s module docs for the same lesson learned there).
    pub id: String,
    /// What the machine is called in the provider's console.
    pub name: String,
    pub private_ip: Option<String>,
    pub public_ip: Option<String>,
    /// The region (Azure) or zone (GCP), shown so two machines with the same
    /// name in different places can be told apart.
    pub location: String,
    /// The resource group (Azure) or project (GCP) that owns it.
    pub scope: String,
    /// Provider-reported power state, verbatim (`VM running`, `RUNNING`,
    /// `TERMINATED`…). Shown rather than reduced to a boolean: a stopped
    /// machine is worth importing, and hiding *why* it can't be reached today
    /// would make the panel look wrong.
    pub state: String,
    /// Whether that state means the machine is up. Typed here rather than left
    /// for the frontend to match on strings, for the same reason
    /// `AwsCliError::session_expired` is typed.
    pub running: bool,
    /// `Linux` / `Windows` when the provider says. Shown, never used to filter:
    /// the EC2 panel lists everything too, and deciding for the user which of
    /// their machines are worth seeing is how a list starts looking broken.
    pub os_type: Option<String>,
    /// The login the provider records for the machine, when it records one
    /// (Azure's `adminUsername`). `None` leaves it to the form, which applies
    /// one login to the whole batch.
    pub username: Option<String>,
    /// Provider tags/labels, offered as Guiterm tags at import time — so
    /// `target tag: prod` in the adaptive language works on the fleet straight
    /// after an import, which is most of the point of importing it.
    pub tags: Vec<(String, String)>,
}

impl CloudInstance {
    /// The address to connect to: the public one when there is one, otherwise
    /// the private one.
    ///
    /// Both are kept and both are shown. A private address is not a failure
    /// here — this app reaches private machines through bastions and proxy
    /// commands every day — so an instance with no public IP is offered
    /// normally rather than listed as a problem.
    pub fn address(&self) -> Option<&str> {
        self.public_ip
            .as_deref()
            .filter(|ip| !ip.is_empty())
            .or(self.private_ip.as_deref().filter(|ip| !ip.is_empty()))
    }
}

/// One instance the user ticked, with the edits the form allows.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSelection {
    /// The provider resource id — carried through so the import writes the
    /// same identity a later re-import will match on.
    pub id: String,
    pub label: String,
    pub address: String,
    pub username: String,
    pub port: u16,
    pub group_id: Option<GroupId>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A scope the user picks before listing: an Azure subscription or a GCP
/// project. One type for both, because the panels do the same thing with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudScope {
    /// What the CLI is passed (`--subscription`, `--project`).
    pub id: String,
    /// What the user recognises.
    pub name: String,
    /// The one the CLI would use with no flag, preselected in the form.
    pub is_default: bool,
}

/// Creates the hosts of one cloud import, refreshing the ones already there.
///
/// Re-importing is the ordinary case: instances come and go, and an import
/// that appended a second copy of every machine already listed would be
/// unusable after the first run.
///
/// **Only what the provider owns is refreshed** — the address and the tags.
/// The label, the login, the port, the group and the credentials are the
/// user's own decisions, and a re-import that undid an edit would make the
/// feature useless on any list someone has curated. Same rule as the EC2 and
/// Ansible paths, and the reason this can't simply overwrite the host.
pub fn apply_import(
    workspace: &mut Workspace,
    provider: Provider,
    scope: &str,
    selections: Vec<CloudSelection>,
    auth: &AuthMethod,
) -> crate::aws_inventory::ImportOutcome {
    let mut outcome = crate::aws_inventory::ImportOutcome::default();
    for selection in selections {
        let source = HostSource::new(provider.source_kind(), selection.id).in_scope(scope);
        // Matched on kind and id alone: the scope is provenance, not identity.
        // A machine moved between subscriptions is still that machine, and
        // including the scope here would duplicate it instead of refreshing it.
        if let Some(existing) = workspace.hosts.iter_mut().find(|host| {
            host.source.as_ref().is_some_and(|s| s.kind == source.kind && s.id == source.id)
        }) {
            // Refreshed, since this listing is where it was just seen.
            existing.source = Some(source);
            existing.address = selection.address;
            existing.tags = selection.tags;
            outcome.updated.push(existing.id);
            continue;
        }
        let mut host = Host::new(selection.label, selection.address, selection.username);
        host.port = selection.port;
        host.group_id = selection.group_id;
        host.tags = selection.tags;
        host.auth = auth.clone();
        host.source = Some(source);
        outcome.added.push(host.id);
        workspace.hosts.push(host);
    }
    outcome
}

/// What a listing says about the hosts already imported from it.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDiff {
    /// Hosts attributed to this scope whose instance is no longer in it —
    /// destroyed, or moved elsewhere. Labels, since that is what the user
    /// recognises.
    pub gone: Vec<(crate::model::HostId, String)>,
    /// Instance ids present in the listing that no host carries yet.
    pub not_imported: Vec<String>,
    /// Hosts of this provider that predate scope recording, or that came from
    /// another scope. **Counted, never judged**: without knowing which listing
    /// they belong to, "not in this one" says nothing about whether they still
    /// exist, and reporting them as gone would invite deleting live machines.
    pub unattributed: usize,
}

/// Compares one provider listing against the hosts imported from it.
///
/// The half `apply_import` never had: it refreshes what is still there and
/// adds what is new, but nothing ever noticed what *disappeared*. A destroyed
/// VM stayed in the list forever, and a VM created since the last import
/// existed nowhere — which is how an imported inventory quietly stops
/// describing reality.
///
/// Scoped deliberately. A GCP instance id is a bare number carrying no
/// project, so a host can only be declared gone when it is known to belong to
/// the listing being checked — see [`crate::model::HostSource::scope`].
pub fn diff(
    workspace: &Workspace,
    provider: Provider,
    scope: &str,
    listed: &[CloudInstance],
) -> InventoryDiff {
    let kind = provider.source_kind();
    let listed_ids: std::collections::HashSet<&str> =
        listed.iter().map(|instance| instance.id.as_str()).collect();

    let mut result = InventoryDiff::default();
    let mut imported_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for host in &workspace.hosts {
        let Some(source) = host.source.as_ref().filter(|s| s.kind == kind) else {
            continue;
        };
        imported_ids.insert(source.id.as_str());
        match source.scope.as_deref() {
            Some(host_scope) if host_scope == scope => {
                if !listed_ids.contains(source.id.as_str()) {
                    result.gone.push((host.id, host.label.clone()));
                }
            }
            // Another scope, or none recorded at all: this listing has nothing
            // to say about it.
            _ => result.unattributed += 1,
        }
    }

    result.not_imported = listed
        .iter()
        .filter(|instance| !imported_ids.contains(instance.id.as_str()))
        .map(|instance| instance.id.clone())
        .collect();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(id: &str, label: &str, address: &str) -> CloudSelection {
        CloudSelection {
            id: id.to_string(),
            label: label.to_string(),
            address: address.to_string(),
            username: "ubuntu".to_string(),
            port: 22,
            group_id: None,
            tags: vec![],
        }
    }

    fn instance(public: Option<&str>, private: Option<&str>) -> CloudInstance {
        CloudInstance {
            id: "id".to_string(),
            name: "n".to_string(),
            private_ip: private.map(str::to_string),
            public_ip: public.map(str::to_string),
            location: "l".to_string(),
            scope: "s".to_string(),
            state: "running".to_string(),
            running: true,
            os_type: None,
            username: None,
            tags: vec![],
        }
    }

    #[test]
    fn public_address_wins_but_private_is_enough() {
        assert_eq!(instance(Some("20.0.0.1"), Some("10.0.0.1")).address(), Some("20.0.0.1"));
        assert_eq!(instance(None, Some("10.0.0.1")).address(), Some("10.0.0.1"));
        assert_eq!(instance(None, None).address(), None);
    }

    /// Azure reports "no public IP" as an empty string rather than by omitting
    /// the field, so an emptiness check is not the same as an `Option` check —
    /// without it, imported hosts would get an address of `""`.
    #[test]
    fn an_empty_public_ip_falls_back_to_the_private_one() {
        assert_eq!(instance(Some(""), Some("10.0.0.1")).address(), Some("10.0.0.1"));
        assert_eq!(instance(Some(""), Some("")).address(), None);
    }

    // ─── Staleness ───────────────────────────────────────────────────────

    fn imported(workspace: &mut Workspace, provider: Provider, scope: &str, id: &str, label: &str) {
        let mut host = Host::new(label, "10.0.0.1", "root");
        host.source = Some(HostSource::new(provider.source_kind(), id).in_scope(scope));
        workspace.hosts.push(host);
    }

    fn listed(id: &str) -> CloudInstance {
        CloudInstance {
            id: id.to_string(),
            name: id.to_string(),
            private_ip: Some("10.0.0.1".to_string()),
            public_ip: None,
            location: String::new(),
            scope: String::new(),
            state: "running".to_string(),
            running: true,
            os_type: None,
            username: None,
            tags: vec![],
        }
    }

    /// The half `apply_import` never had. A destroyed VM used to stay in the
    /// list forever, and a VM created since the last import existed nowhere.
    #[test]
    fn a_listing_names_what_disappeared_and_what_is_new() {
        let mut workspace = Workspace::default();
        imported(&mut workspace, Provider::Gcp, "projet-a", "111", "toujours-là");
        imported(&mut workspace, Provider::Gcp, "projet-a", "222", "détruite");

        let result = diff(&workspace, Provider::Gcp, "projet-a", &[listed("111"), listed("333")]);

        assert_eq!(result.gone.len(), 1);
        assert_eq!(result.gone[0].1, "détruite");
        assert_eq!(result.not_imported, vec!["333".to_string()]);
        assert_eq!(result.unattributed, 0);
    }

    /// The reason `scope` exists at all. A GCP instance id is a bare number
    /// carrying no project, so without attribution, checking one project would
    /// report every host of the other as destroyed — and invite deleting live
    /// machines.
    #[test]
    fn a_host_from_another_scope_is_never_called_gone() {
        let mut workspace = Workspace::default();
        imported(&mut workspace, Provider::Gcp, "projet-b", "999", "ailleurs");

        let result = diff(&workspace, Provider::Gcp, "projet-a", &[]);

        assert!(result.gone.is_empty(), "un hôte d'un autre projet n'est pas détruit");
        assert_eq!(result.unattributed, 1);
    }

    /// Hosts imported before scope was recorded carry none. Counted, never
    /// judged — same stakes as above.
    #[test]
    fn a_host_imported_before_scopes_existed_is_left_alone() {
        let mut workspace = Workspace::default();
        let mut host = Host::new("ancien", "10.0.0.1", "root");
        host.source = Some(HostSource::new("azure", "/subscriptions/s/vm1"));
        workspace.hosts.push(host);

        let result = diff(&workspace, Provider::Azure, "s", &[]);
        assert!(result.gone.is_empty());
        assert_eq!(result.unattributed, 1);
    }

    /// Another provider's hosts are none of this listing's business.
    #[test]
    fn the_other_provider_is_ignored_entirely() {
        let mut workspace = Workspace::default();
        imported(&mut workspace, Provider::Azure, "sub", "/subscriptions/sub/vm", "azure-vm");

        let result = diff(&workspace, Provider::Gcp, "projet", &[]);
        assert!(result.gone.is_empty());
        assert_eq!(result.unattributed, 0, "un hôte Azure n'est pas un GCP non attribué");
    }

    /// A machine that moved between subscriptions is still that machine: the
    /// scope is provenance, the id is identity. It must be re-attributed by a
    /// re-import, not duplicated.
    #[test]
    fn a_reimport_reattributes_a_host_that_changed_scope() {
        let mut workspace = Workspace::default();
        imported(&mut workspace, Provider::Azure, "ancien-abo", "/vm/1", "web");

        let outcome = apply_import(
            &mut workspace,
            Provider::Azure,
            "nouvel-abo",
            vec![selection("/vm/1", "web", "10.0.0.9")],
            &AuthMethod::Password,
        );

        assert_eq!(outcome.added.len(), 0, "pas de doublon");
        assert_eq!(workspace.hosts.len(), 1);
        assert_eq!(
            workspace.hosts[0].source.as_ref().unwrap().scope.as_deref(),
            Some("nouvel-abo"),
        );
    }

    #[test]
    fn a_first_import_creates_hosts_carrying_their_provenance() {
        let mut workspace = Workspace::default();
        let outcome = apply_import(
            &mut workspace,
            Provider::Azure,
            "test-scope",
            vec![selection("/subscriptions/s/rg/vm1", "web-1", "20.0.0.1")],
            &AuthMethod::Password,
        );
        assert_eq!(outcome.added.len(), 1);
        assert_eq!(workspace.hosts.len(), 1);
        assert_eq!(
            workspace.hosts[0].source,
            Some(HostSource::new("azure", "/subscriptions/s/rg/vm1").in_scope("test-scope")),
        );
    }

    /// The whole point of matching on the resource id: a machine that has been
    /// renamed *and* re-addressed is still the same machine.
    #[test]
    fn a_reimport_refreshes_instead_of_duplicating() {
        let mut workspace = Workspace::default();
        apply_import(
            &mut workspace,
            Provider::Azure,
            "test-scope",
            vec![selection("/subscriptions/s/rg/vm1", "web-1", "20.0.0.1")],
            &AuthMethod::Password,
        );
        let outcome = apply_import(
            &mut workspace,
            Provider::Azure,
            "test-scope",
            vec![selection("/subscriptions/s/rg/vm1", "renamed", "20.9.9.9")],
            &AuthMethod::Password,
        );

        assert_eq!(outcome.added.len(), 0, "aucun hôte ne doit être créé");
        assert_eq!(outcome.updated.len(), 1);
        assert_eq!(workspace.hosts.len(), 1, "l'hôte ne doit pas être dupliqué");
        assert_eq!(workspace.hosts[0].address, "20.9.9.9", "l'adresse est à la source");
    }

    /// The user's own edits survive a re-import. Without this the feature is
    /// unusable on a curated list — you'd re-fix every label every time.
    #[test]
    fn a_reimport_keeps_what_the_user_decided() {
        let mut workspace = Workspace::default();
        apply_import(
            &mut workspace,
            Provider::Gcp,
            "test-scope",
            vec![selection("8888888888", "vm", "34.0.0.1")],
            &AuthMethod::Password,
        );
        let host_id = workspace.hosts[0].id;
        workspace.hosts[0].label = "Mon serveur".to_string();
        workspace.hosts[0].username = "glorin".to_string();
        workspace.hosts[0].port = 2222;

        let mut renamed = selection("8888888888", "vm", "34.0.0.2");
        renamed.username = "root".to_string();
        renamed.port = 22;
        apply_import(&mut workspace, Provider::Gcp, "test-scope", vec![renamed], &AuthMethod::Password);

        let host = &workspace.hosts[0];
        assert_eq!(host.id, host_id);
        assert_eq!(host.label, "Mon serveur", "le libellé appartient à l'utilisateur");
        assert_eq!(host.username, "glorin", "le login appartient à l'utilisateur");
        assert_eq!(host.port, 2222, "le port appartient à l'utilisateur");
        assert_eq!(host.address, "34.0.0.2", "l'adresse appartient à la source");
    }

    /// Two providers can hand out the same id string without colliding — the
    /// source is the pair, not the id alone.
    #[test]
    fn providers_do_not_match_each_others_hosts() {
        let mut workspace = Workspace::default();
        apply_import(
            &mut workspace,
            Provider::Azure,
            "test-scope",
            vec![selection("shared-id", "azure-vm", "20.0.0.1")],
            &AuthMethod::Password,
        );
        let outcome = apply_import(
            &mut workspace,
            Provider::Gcp,
            "test-scope",
            vec![selection("shared-id", "gcp-vm", "34.0.0.1")],
            &AuthMethod::Password,
        );

        assert_eq!(outcome.added.len(), 1, "un id identique chez l'autre fournisseur est un autre hôte");
        assert_eq!(workspace.hosts.len(), 2);
    }

    /// Hosts imported from AWS or Ansible must be invisible to a cloud
    /// re-import — matching them would rewrite an address the other importer
    /// owns.
    #[test]
    fn hosts_from_another_source_are_left_alone() {
        let mut workspace = Workspace::default();
        let mut ansible = Host::new("legacy", "10.0.0.1", "root");
        ansible.source = Some(HostSource::ansible("web1.example.com"));
        workspace.hosts.push(ansible);
        let mut plain = Host::new("hand-made", "10.0.0.2", "root");
        plain.source = None;
        workspace.hosts.push(plain);

        apply_import(
            &mut workspace,
            Provider::Azure,
            "test-scope",
            vec![selection("web1.example.com", "vm", "20.0.0.1")],
            &AuthMethod::Password,
        );

        assert_eq!(workspace.hosts.len(), 3);
        assert_eq!(workspace.hosts[0].address, "10.0.0.1", "l'hôte Ansible est intact");
        assert_eq!(workspace.hosts[1].address, "10.0.0.2", "l'hôte manuel est intact");
    }
}
