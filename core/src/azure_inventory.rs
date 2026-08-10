//! Discovering Azure VMs through the user's own `az` CLI.
//!
//! The provider-specific half of the import: which command to run, and how to
//! read what it answers. Everything after that — the instance shape, the
//! matching rule, what a re-import refreshes — is
//! [`crate::cloud_inventory`]; running the CLI and classifying its refusals is
//! [`crate::cloud_cli`].
//!
//! **Why `--show-details`.** A plain `az vm list` returns the ARM resource and
//! nothing else: the network interfaces appear as references, so it yields no
//! address at all, which is the one thing an SSH client needs. `-d` makes the
//! CLI resolve them and adds `publicIps`/`privateIps`/`powerState`. It costs
//! extra calls on Azure's side — hence the generous timeout in `cloud_cli` —
//! but the alternative is a second round of `az vm list-ip-addresses` that we
//! would then have to join by hand, for the same wait.

use crate::cloud_cli::{self, CloudCliError, Provider};
use crate::cloud_inventory::{CloudInstance, CloudScope};
use serde::Deserialize;

/// The subscriptions the CLI is logged in to.
pub async fn list_subscriptions() -> Result<Vec<CloudScope>, CloudCliError> {
    let stdout = cloud_cli::run(Provider::Azure, &["account", "list", "--output", "json"]).await?;
    parse_subscriptions(&stdout)
}

/// The VMs of one subscription, or of the CLI's default one when `None`.
pub async fn list_vms(subscription: Option<&str>) -> Result<Vec<CloudInstance>, CloudCliError> {
    let mut args = vec!["vm", "list", "--show-details", "--output", "json"];
    if let Some(subscription) = subscription.filter(|s| !s.is_empty()) {
        args.push("--subscription");
        args.push(subscription);
    }
    let stdout = cloud_cli::run(Provider::Azure, &args).await?;
    parse_vms(&stdout)
}

// ─── Parsing ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubscription {
    id: String,
    name: String,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    state: Option<String>,
}

pub fn parse_subscriptions(stdout: &str) -> Result<Vec<CloudScope>, CloudCliError> {
    let raw: Vec<RawSubscription> = serde_json::from_str(stdout).map_err(|e| {
        CloudCliError::Unreadable {
            message: format!("Réponse de `az account list` illisible : {e}"),
        }
    })?;
    Ok(raw
        .into_iter()
        // A disabled or expired subscription can't be listed and would only
        // produce a confusing refusal if picked.
        .filter(|s| s.state.as_deref().unwrap_or("Enabled").eq_ignore_ascii_case("enabled"))
        .map(|s| CloudScope {
            id: s.id,
            name: s.name,
            is_default: s.is_default,
        })
        .collect())
}

/// One VM as `az vm list -d` reports it.
///
/// `deny_unknown_fields` is deliberately **not** set: `az` adds properties
/// between versions, and refusing to parse a payload because it grew would
/// break the import on every CLI update.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawVm {
    id: String,
    name: String,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    resource_group: Option<String>,
    /// `-d` only. Comma-separated when a VM has several, empty string when it
    /// has none — not absent, which is why the empty case is handled
    /// explicitly rather than left to `Option`.
    #[serde(default)]
    public_ips: Option<String>,
    #[serde(default)]
    private_ips: Option<String>,
    /// `-d` only: "VM running", "VM deallocated", "VM stopped"…
    #[serde(default)]
    power_state: Option<String>,
    #[serde(default)]
    os_profile: Option<RawOsProfile>,
    #[serde(default)]
    storage_profile: Option<RawStorageProfile>,
    /// `null` when the VM has none — hence `Option`, not just `default`.
    #[serde(default)]
    tags: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOsProfile {
    #[serde(default)]
    admin_username: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStorageProfile {
    #[serde(default)]
    os_disk: Option<RawOsDisk>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOsDisk {
    #[serde(default)]
    os_type: Option<String>,
}

pub fn parse_vms(stdout: &str) -> Result<Vec<CloudInstance>, CloudCliError> {
    let raw: Vec<RawVm> =
        serde_json::from_str(stdout).map_err(|e| CloudCliError::Unreadable {
            message: format!("Réponse de `az vm list` illisible : {e}"),
        })?;

    Ok(raw.into_iter().map(instance_from).collect())
}

fn instance_from(vm: RawVm) -> CloudInstance {
    let state = vm.power_state.unwrap_or_else(|| "état inconnu".to_string());
    CloudInstance {
        // Falls back to the resource group when `-d` is somehow absent, so a
        // machine is never listed with an empty subtitle.
        scope: vm
            .resource_group
            .or_else(|| resource_group_of(&vm.id).map(str::to_string))
            .unwrap_or_default(),
        // Azure hands several addresses back in one comma-separated string.
        // The first is the one to use; showing all of them would not fit the
        // column and picking the last would be arbitrary.
        public_ip: first_address(vm.public_ips.as_deref()),
        private_ip: first_address(vm.private_ips.as_deref()),
        running: state.to_lowercase().contains("running"),
        state,
        location: vm.location.unwrap_or_default(),
        os_type: vm.storage_profile.and_then(|s| s.os_disk).and_then(|d| d.os_type),
        username: vm
            .os_profile
            .and_then(|p| p.admin_username)
            .filter(|u| !u.is_empty()),
        tags: vm.tags.unwrap_or_default().into_iter().collect(),
        id: vm.id,
        name: vm.name,
    }
}

/// The first of a comma-separated address list, empty strings treated as none.
fn first_address(raw: Option<&str>) -> Option<String> {
    raw?.split(',')
        .map(str::trim)
        .find(|part| !part.is_empty())
        .map(str::to_string)
}

/// The resource group embedded in an ARM resource id.
///
/// Azure spells the segment `resourceGroups` in the id but returns
/// `resourceGroup` as a field; matching case-insensitively avoids depending on
/// which one a given CLI version emits.
fn resource_group_of(id: &str) -> Option<&str> {
    let mut parts = id.split('/');
    while let Some(part) = parts.next() {
        if part.eq_ignore_ascii_case("resourceGroups") {
            return parts.next().filter(|p| !p.is_empty());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a real `az account list` on 2026-08-10 (identifiers
    /// scrambled). Kept in the shape the CLI actually emits, extra fields and
    /// all — a trimmed sample would not prove the parser tolerates them.
    const ACCOUNTS: &str = r#"[
      {
        "cloudName": "AzureCloud",
        "homeTenantId": "eeff6f72-0000-0000-0000-064920c95e17",
        "id": "dacbc157-0000-0000-0000-71a1fd3457f1",
        "isDefault": true,
        "managedByTenants": [],
        "name": "Abonnement_ASR_Azure",
        "state": "Enabled",
        "tenantDefaultDomain": "example.onmicrosoft.com",
        "tenantDisplayName": "Example",
        "tenantId": "eeff6f72-0000-0000-0000-064920c95e17",
        "user": { "name": "admin@example.onmicrosoft.com", "type": "user" }
      },
      {
        "cloudName": "AzureCloud",
        "id": "00000000-0000-0000-0000-000000000002",
        "isDefault": false,
        "name": "Abonnement désactivé",
        "state": "Disabled",
        "tenantId": "eeff6f72-0000-0000-0000-064920c95e17"
      }
    ]"#;

    const VMS: &str = r#"[
      {
        "id": "/subscriptions/dacbc157-0000-0000-0000-71a1fd3457f1/resourceGroups/RG-PROD/providers/Microsoft.Compute/virtualMachines/web-01",
        "name": "web-01",
        "location": "francecentral",
        "resourceGroup": "RG-PROD",
        "powerState": "VM running",
        "publicIps": "20.19.7.42",
        "privateIps": "10.0.1.4",
        "osProfile": { "adminUsername": "azureuser", "computerName": "web-01" },
        "storageProfile": { "osDisk": { "osType": "Linux", "diskSizeGb": 30 } },
        "tags": { "env": "prod", "role": "web" },
        "hardwareProfile": { "vmSize": "Standard_B2s" }
      },
      {
        "id": "/subscriptions/dacbc157-0000-0000-0000-71a1fd3457f1/resourceGroups/RG-PROD/providers/Microsoft.Compute/virtualMachines/db-01",
        "name": "db-01",
        "location": "francecentral",
        "resourceGroup": "RG-PROD",
        "powerState": "VM deallocated",
        "publicIps": "",
        "privateIps": "10.0.1.5,10.0.2.5",
        "osProfile": { "adminUsername": "azureuser" },
        "storageProfile": { "osDisk": { "osType": "Linux" } },
        "tags": null
      },
      {
        "id": "/subscriptions/dacbc157-0000-0000-0000-71a1fd3457f1/resourceGroups/RG-WIN/providers/Microsoft.Compute/virtualMachines/ad-01",
        "name": "ad-01",
        "location": "westeurope",
        "resourceGroup": "RG-WIN",
        "powerState": "VM running",
        "publicIps": "51.11.22.33",
        "privateIps": "10.1.0.4",
        "osProfile": { "adminUsername": "Administrator" },
        "storageProfile": { "osDisk": { "osType": "Windows" } }
      }
    ]"#;

    #[test]
    fn subscriptions_are_read_and_the_default_is_flagged() {
        let scopes = parse_subscriptions(ACCOUNTS).unwrap();
        assert_eq!(scopes.len(), 1, "l'abonnement désactivé est écarté");
        assert_eq!(scopes[0].name, "Abonnement_ASR_Azure");
        assert_eq!(scopes[0].id, "dacbc157-0000-0000-0000-71a1fd3457f1");
        assert!(scopes[0].is_default);
    }

    #[test]
    fn vms_are_read_with_their_addresses_and_state() {
        let vms = parse_vms(VMS).unwrap();
        assert_eq!(vms.len(), 3);

        let web = &vms[0];
        assert_eq!(web.name, "web-01");
        assert_eq!(web.public_ip.as_deref(), Some("20.19.7.42"));
        assert_eq!(web.private_ip.as_deref(), Some("10.0.1.4"));
        assert_eq!(web.address(), Some("20.19.7.42"));
        assert!(web.running);
        assert_eq!(web.username.as_deref(), Some("azureuser"));
        assert_eq!(web.os_type.as_deref(), Some("Linux"));
        assert_eq!(web.scope, "RG-PROD");
        assert_eq!(web.location, "francecentral");
        assert_eq!(
            web.tags,
            vec![
                ("env".to_string(), "prod".to_string()),
                ("role".to_string(), "web".to_string())
            ]
        );
    }

    /// The empty-string case Azure actually emits, and the reason
    /// `CloudInstance::address` filters on emptiness rather than on `Option`.
    /// Without it this host would be imported with an address of `""`.
    #[test]
    fn a_vm_with_no_public_ip_falls_back_to_its_private_one() {
        let db = &parse_vms(VMS).unwrap()[1];
        assert_eq!(db.public_ip, None);
        assert_eq!(db.private_ip.as_deref(), Some("10.0.1.5"), "la première des deux");
        assert_eq!(db.address(), Some("10.0.1.5"));
        assert!(!db.running, "« VM deallocated » n'est pas en marche");
        assert!(db.tags.is_empty(), "`tags: null` n'est pas une erreur");
    }

    /// Windows VMs are listed, not hidden — same rule as the EC2 panel. The
    /// panel shows the OS so the user decides.
    #[test]
    fn windows_vms_are_listed_with_their_os() {
        let ad = &parse_vms(VMS).unwrap()[2];
        assert_eq!(ad.os_type.as_deref(), Some("Windows"));
        assert_eq!(ad.scope, "RG-WIN");
    }

    /// The identity a re-import matches on. If this ever came out as the name,
    /// renaming a VM in the portal would orphan its host and create a second.
    #[test]
    fn the_matching_id_is_the_full_resource_id() {
        let web = &parse_vms(VMS).unwrap()[0];
        assert!(web.id.starts_with("/subscriptions/"));
        assert!(web.id.ends_with("/virtualMachines/web-01"));
    }

    #[test]
    fn an_empty_account_list_is_not_an_error() {
        assert_eq!(parse_vms("[]").unwrap().len(), 0);
        assert_eq!(parse_subscriptions("[]").unwrap().len(), 0);
    }

    #[test]
    fn unreadable_output_is_reported_as_such() {
        let err = parse_vms("not json at all").unwrap_err();
        assert!(matches!(err, CloudCliError::Unreadable { .. }));
    }

    /// A VM listed without `-d` details still parses, rather than taking the
    /// whole import down with it.
    #[test]
    fn a_vm_missing_the_detail_fields_still_parses() {
        let json = r#"[{
          "id": "/subscriptions/s/resourceGroups/RG-X/providers/Microsoft.Compute/virtualMachines/bare",
          "name": "bare"
        }]"#;
        let vm = &parse_vms(json).unwrap()[0];
        assert_eq!(vm.address(), None);
        assert!(!vm.running);
        assert_eq!(vm.state, "état inconnu");
        assert_eq!(vm.scope, "RG-X", "le groupe est retrouvé dans l'id ARM");
    }

    #[test]
    fn the_resource_group_is_found_in_an_arm_id() {
        assert_eq!(
            resource_group_of("/subscriptions/s/resourceGroups/RG/providers/x/virtualMachines/v"),
            Some("RG")
        );
        assert_eq!(resource_group_of("/subscriptions/s"), None);
    }
}
