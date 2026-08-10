//! Discovering Compute Engine instances through the user's own `gcloud` CLI.
//!
//! Mirror of [`crate::azure_inventory`]: only the command and the JSON shape
//! differ, everything downstream is [`crate::cloud_inventory`].
//!
//! **Two GCP-specific wrinkles**, both about identity:
//!
//! - The matching id is the **numeric instance id**, not the name. GCP names
//!   are unique only within a zone and only while the instance lives, and a
//!   delete/recreate cycle reuses them freely — matching on the name would let
//!   a new machine silently inherit an old host's credentials.
//! - `zone` and `machineType` come back as **full resource URLs**
//!   (`https://…/zones/europe-west1-b`), which are unreadable in a table. Only
//!   the last segment is kept.
//!
//! There is no reliable per-instance login to read: GCP provisions accounts
//! through OS Login or project metadata rather than recording one on the
//! instance, so [`crate::cloud_inventory::CloudInstance::username`] is left
//! `None` and the form's batch login applies. Guessing one from the image
//! would be wrong far more often than Azure's `adminUsername` is.

use crate::cloud_cli::{self, CloudCliError, Provider};
use crate::cloud_inventory::{CloudInstance, CloudScope};
use serde::Deserialize;

/// The projects the CLI can see.
pub async fn list_projects() -> Result<Vec<CloudScope>, CloudCliError> {
    let stdout = cloud_cli::run(
        Provider::Gcp,
        &["projects", "list", "--format=json"],
    )
    .await?;
    let active = parse_projects(&stdout)?;
    let current = current_project().await;
    Ok(active
        .into_iter()
        .map(|mut scope| {
            scope.is_default = Some(&scope.id) == current.as_ref();
            scope
        })
        .collect())
}

/// The project `gcloud` would use with no `--project`, if one is configured.
///
/// A failure here is not a failure of the listing: it only decides which entry
/// is preselected, so it degrades to "none preselected" rather than taking the
/// whole panel down.
async fn current_project() -> Option<String> {
    let stdout = cloud_cli::run(
        Provider::Gcp,
        &["config", "get-value", "project", "--format=json"],
    )
    .await
    .ok()?;
    let trimmed = stdout.trim().trim_matches('"');
    // `gcloud` prints the literal string "(unset)" when there is no default.
    if trimmed.is_empty() || trimmed == "(unset)" || trimmed == "null" {
        return None;
    }
    Some(trimmed.to_string())
}

/// The instances of one project, or of the CLI's default one when `None`.
pub async fn list_instances(project: Option<&str>) -> Result<Vec<CloudInstance>, CloudCliError> {
    let flag;
    let mut args = vec!["compute", "instances", "list", "--format=json"];
    if let Some(project) = project.filter(|p| !p.is_empty()) {
        flag = format!("--project={project}");
        args.push(&flag);
    }
    let stdout = cloud_cli::run(Provider::Gcp, &args).await?;
    parse_instances(&stdout)
}

// ─── Parsing ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProject {
    project_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    lifecycle_state: Option<String>,
}

pub fn parse_projects(stdout: &str) -> Result<Vec<CloudScope>, CloudCliError> {
    let raw: Vec<RawProject> =
        serde_json::from_str(stdout).map_err(|e| CloudCliError::Unreadable {
            message: format!("Réponse de `gcloud projects list` illisible : {e}"),
        })?;
    Ok(raw
        .into_iter()
        // A project being deleted can't be listed and would only produce a
        // confusing refusal if picked.
        .filter(|p| {
            p.lifecycle_state
                .as_deref()
                .unwrap_or("ACTIVE")
                .eq_ignore_ascii_case("active")
        })
        .map(|p| CloudScope {
            name: p.name.unwrap_or_else(|| p.project_id.clone()),
            id: p.project_id,
            is_default: false,
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInstance {
    /// A numeric id, but JSON-encoded as a string because it exceeds what a
    /// double can hold exactly — deserialising it as a number would round it.
    id: String,
    name: String,
    #[serde(default)]
    zone: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    network_interfaces: Vec<RawNic>,
    /// User-defined labels — the GCP equivalent of tags.
    #[serde(default)]
    labels: std::collections::BTreeMap<String, String>,
    /// **Network** tags, a different concept: firewall targets, with no
    /// values. Merged in as valueless tags because that is how people label
    /// roles on GCP (`http-server`, `prod`), and the adaptive language's
    /// `target tag:` should see them.
    #[serde(default)]
    tags: RawNetworkTags,
}

#[derive(Debug, Default, Deserialize)]
struct RawNetworkTags {
    #[serde(default)]
    items: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawNic {
    /// **`networkIP`, not `networkIp`.** The Compute API capitalises the
    /// acronym, so `rename_all = "camelCase"` derives the wrong name and the
    /// field silently deserialises to `None` — every instance would come back
    /// with no private address and nothing would report an error. Spelled out
    /// explicitly, and covered by a test on real output shape.
    #[serde(default, rename = "networkIP")]
    network_ip: Option<String>,
    #[serde(default)]
    access_configs: Vec<RawAccessConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAccessConfig {
    /// Absent while an ephemeral address is being assigned, and on instances
    /// that have an access config but no external address. Same capitalised
    /// acronym as `networkIP` above.
    #[serde(default, rename = "natIP")]
    nat_ip: Option<String>,
}

pub fn parse_instances(stdout: &str) -> Result<Vec<CloudInstance>, CloudCliError> {
    let raw: Vec<RawInstance> =
        serde_json::from_str(stdout).map_err(|e| CloudCliError::Unreadable {
            message: format!("Réponse de `gcloud compute instances list` illisible : {e}"),
        })?;
    Ok(raw.into_iter().map(instance_from).collect())
}

fn instance_from(vm: RawInstance) -> CloudInstance {
    let status = vm.status.unwrap_or_else(|| "état inconnu".to_string());
    let zone = vm.zone.as_deref().map(last_segment).unwrap_or_default();

    let private_ip = vm
        .network_interfaces
        .iter()
        .find_map(|nic| nic.network_ip.clone())
        .filter(|ip| !ip.is_empty());
    let public_ip = vm
        .network_interfaces
        .iter()
        .flat_map(|nic| nic.access_configs.iter())
        .find_map(|config| config.nat_ip.clone())
        .filter(|ip| !ip.is_empty());

    let mut tags: Vec<(String, String)> = vm.labels.into_iter().collect();
    tags.extend(vm.tags.items.into_iter().map(|item| (item, String::new())));

    CloudInstance {
        id: vm.id,
        name: vm.name,
        private_ip,
        public_ip,
        // The project, read out of the same URL the zone comes from. It has no
        // field of its own in the listing, and putting the zone here too made
        // every row read "europe-west1-b · europe-west1-b" — the Azure side
        // hid the mistake, since a region and a resource group differ.
        scope: vm.zone.as_deref().map(project_of).unwrap_or_default(),
        location: zone,
        running: status.eq_ignore_ascii_case("running"),
        state: status,
        // GCP doesn't report an OS on the instance listing — the image lives
        // on the boot disk, which this call doesn't expand.
        os_type: None,
        username: None,
        tags,
    }
}

/// The last path segment of a GCP resource URL, which is the readable name.
fn last_segment(url: &str) -> String {
    url.rsplit('/').next().unwrap_or(url).to_string()
}

/// The project embedded in a GCP resource URL (`…/projects/NAME/zones/…`).
///
/// Empty when the URL isn't one — the panel already knows which project it
/// asked for, so a blank subtitle is better than a wrong one.
fn project_of(url: &str) -> String {
    let mut parts = url.split('/');
    while let Some(part) = parts.next() {
        if part == "projects" {
            return parts.next().unwrap_or_default().to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `gcloud compute instances list --format=json` emits: resource
    /// URLs for zone and machine type, addresses nested two levels down, and
    /// the numeric id as a *string*.
    const INSTANCES: &str = r#"[
      {
        "id": "8574839201847362910",
        "name": "web-01",
        "zone": "https://www.googleapis.com/compute/v1/projects/mon-projet/zones/europe-west1-b",
        "machineType": "https://www.googleapis.com/compute/v1/projects/mon-projet/zones/europe-west1-b/machineTypes/e2-medium",
        "status": "RUNNING",
        "labels": { "env": "prod" },
        "tags": { "items": ["http-server", "https-server"], "fingerprint": "abc=" },
        "networkInterfaces": [
          {
            "networkIP": "10.132.0.2",
            "name": "nic0",
            "accessConfigs": [
              { "type": "ONE_TO_ONE_NAT", "name": "External NAT", "natIP": "34.79.12.5" }
            ]
          }
        ]
      },
      {
        "id": "1122334455667788990",
        "name": "db-01",
        "zone": "https://www.googleapis.com/compute/v1/projects/mon-projet/zones/europe-west1-c",
        "status": "TERMINATED",
        "networkInterfaces": [
          { "networkIP": "10.132.0.3", "name": "nic0" }
        ]
      }
    ]"#;

    const PROJECTS: &str = r#"[
      { "projectId": "mon-projet", "name": "Mon Projet", "projectNumber": "123", "lifecycleState": "ACTIVE" },
      { "projectId": "vieux-projet", "name": "Vieux", "lifecycleState": "DELETE_REQUESTED" }
    ]"#;

    #[test]
    fn instances_are_read_with_addresses_from_the_nested_shape() {
        let vms = parse_instances(INSTANCES).unwrap();
        assert_eq!(vms.len(), 2);

        let web = &vms[0];
        assert_eq!(web.name, "web-01");
        assert_eq!(web.private_ip.as_deref(), Some("10.132.0.2"));
        assert_eq!(web.public_ip.as_deref(), Some("34.79.12.5"));
        assert_eq!(web.address(), Some("34.79.12.5"));
        assert!(web.running);
        assert_eq!(web.username, None, "GCP ne rapporte pas de login d'instance");
    }

    /// The reason `id` is deserialised as a string: as an `f64` this value
    /// would come back as 8574839201847363000 and match nothing on re-import.
    #[test]
    fn the_numeric_id_survives_intact() {
        let web = &parse_instances(INSTANCES).unwrap()[0];
        assert_eq!(web.id, "8574839201847362910");
    }

    #[test]
    fn resource_urls_are_shortened_to_something_readable() {
        let vms = parse_instances(INSTANCES).unwrap();
        assert_eq!(vms[0].location, "europe-west1-b");
        assert_eq!(vms[1].location, "europe-west1-c");
    }

    /// The zone and the project are two different things. They were briefly
    /// both the zone, which made every row read "europe-west1-b ·
    /// europe-west1-b" — invisible on the Azure side, where a region and a
    /// resource group differ.
    #[test]
    fn the_scope_is_the_project_not_the_zone_again() {
        let web = &parse_instances(INSTANCES).unwrap()[0];
        assert_eq!(web.scope, "mon-projet");
        assert_ne!(web.scope, web.location);
    }

    #[test]
    fn a_zone_that_is_not_a_resource_url_yields_no_project() {
        let json = r#"[{"id":"1","name":"n","zone":"europe-west1-b"}]"#;
        let vm = &parse_instances(json).unwrap()[0];
        assert_eq!(vm.location, "europe-west1-b");
        assert_eq!(vm.scope, "", "mieux vaut un sous-titre vide qu'un faux");
    }

    #[test]
    fn an_instance_with_no_external_address_keeps_its_internal_one() {
        let db = &parse_instances(INSTANCES).unwrap()[1];
        assert_eq!(db.public_ip, None);
        assert_eq!(db.address(), Some("10.132.0.3"));
        assert!(!db.running, "TERMINATED n'est pas en marche");
    }

    /// Labels carry values, network tags don't — both end up targetable by
    /// `target tag:` in the adaptive language.
    #[test]
    fn labels_and_network_tags_both_become_tags() {
        let web = &parse_instances(INSTANCES).unwrap()[0];
        assert_eq!(
            web.tags,
            vec![
                ("env".to_string(), "prod".to_string()),
                ("http-server".to_string(), String::new()),
                ("https-server".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn projects_being_deleted_are_left_out() {
        let scopes = parse_projects(PROJECTS).unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].id, "mon-projet");
        assert_eq!(scopes[0].name, "Mon Projet");
    }

    #[test]
    fn a_project_without_a_display_name_falls_back_to_its_id() {
        let scopes = parse_projects(r#"[{"projectId": "brut"}]"#).unwrap();
        assert_eq!(scopes[0].name, "brut");
    }

    #[test]
    fn unreadable_output_is_reported_as_such() {
        assert!(matches!(
            parse_instances("nope").unwrap_err(),
            CloudCliError::Unreadable { .. }
        ));
    }

    #[test]
    fn an_empty_project_is_not_an_error() {
        assert_eq!(parse_instances("[]").unwrap().len(), 0);
    }
}
