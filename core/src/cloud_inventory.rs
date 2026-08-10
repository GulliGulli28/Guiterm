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
    selections: Vec<CloudSelection>,
    auth: &AuthMethod,
) -> crate::aws_inventory::ImportOutcome {
    let mut outcome = crate::aws_inventory::ImportOutcome::default();
    for selection in selections {
        let source = HostSource {
            kind: provider.source_kind().to_string(),
            id: selection.id,
        };
        if let Some(existing) = workspace
            .hosts
            .iter_mut()
            .find(|host| host.source.as_ref() == Some(&source))
        {
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

    #[test]
    fn a_first_import_creates_hosts_carrying_their_provenance() {
        let mut workspace = Workspace::default();
        let outcome = apply_import(
            &mut workspace,
            Provider::Azure,
            vec![selection("/subscriptions/s/rg/vm1", "web-1", "20.0.0.1")],
            &AuthMethod::Password,
        );
        assert_eq!(outcome.added.len(), 1);
        assert_eq!(workspace.hosts.len(), 1);
        assert_eq!(
            workspace.hosts[0].source,
            Some(HostSource {
                kind: "azure".to_string(),
                id: "/subscriptions/s/rg/vm1".to_string()
            })
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
            vec![selection("/subscriptions/s/rg/vm1", "web-1", "20.0.0.1")],
            &AuthMethod::Password,
        );
        let outcome = apply_import(
            &mut workspace,
            Provider::Azure,
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
        apply_import(&mut workspace, Provider::Gcp, vec![renamed], &AuthMethod::Password);

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
            vec![selection("shared-id", "azure-vm", "20.0.0.1")],
            &AuthMethod::Password,
        );
        let outcome = apply_import(
            &mut workspace,
            Provider::Gcp,
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
            vec![selection("web1.example.com", "vm", "20.0.0.1")],
            &AuthMethod::Password,
        );

        assert_eq!(workspace.hosts.len(), 3);
        assert_eq!(workspace.hosts[0].address, "10.0.0.1", "l'hôte Ansible est intact");
        assert_eq!(workspace.hosts[1].address, "10.0.0.2", "l'hôte manuel est intact");
    }
}
