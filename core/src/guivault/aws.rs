//! Les accès AWS du coffre ↔ la configuration AWS de cette machine.
//!
//! Un item `aws` (`guivault_items::AwsAccess`, écrit aussi par l'interface
//! web de GuiVault) décrit une session SSO (IAM Identity Center) et ses
//! profils, ou des clés d'accès IAM. Deux sens :
//!
//! - [`save_session`] : une session SSO de `~/.aws/config` et les profils
//!   qui passent par elle → un item du coffre. Mis à jour s'il existe déjà
//!   (même URL de démarrage et même nom de session), où qu'il soit rangé,
//!   sinon créé dans le vault personnel. Les profils du coffre que cette
//!   machine n'a pas sont gardés : enregistrer depuis un poste n'efface pas
//!   ce qu'un autre a ajouté.
//! - [`apply`] : un item du coffre → `~/.aws/config` (et `~/.aws/credentials`
//!   pour des clés), section par section, sans toucher au reste du fichier
//!   ([`aws_sso::upsert_section`]). Reste à se connecter (`aws sso login`),
//!   ce que le panneau AWS propose ensuite.
//!
//! Comme [`super::browse`], ce module lit les items lui-même et ne passe pas
//! par la synchro : un secret de l'interface web n'entre jamais dans son
//! état (voir `browse.rs`).
use super::account::Manager;
use crate::aws_inventory::{self, AwsCliError, AwsProfile, AwsSsoSession};
use crate::aws_sso;
use crate::model::VaultId;
use guivault_crypto as gc;
use guivault_items::{AwsAccess, AwsAuthType, AwsProfileEntry, SecretBase, SecretItem, TYPE_AWS};
use guivault_protocol::{self as proto, Role, VaultKind};
use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;

/// `~/.aws/config` et `~/.aws/credentials` tels que l'accès les écrirait —
/// le même texte que la fiche de l'interface web (`awsConfigText`).
pub fn config_text(a: &AwsAccess) -> (String, String) {
    let mut config: Vec<String> = Vec::new();
    let mut credentials: Vec<String> = Vec::new();
    let session = session_name(a);
    if a.auth_type == AwsAuthType::Sso {
        config.push(format!("[sso-session {session}]"));
        config.extend(sso_session_body(a));
        config.push(String::new());
    }
    for p in profiles_or_default(a) {
        config.push(profile_header(&p.name));
        config.extend(profile_body(a, &p, &session));
        config.push(String::new());
        if a.auth_type == AwsAuthType::Keys {
            credentials.push(format!("[{}]", p.name));
            credentials.extend(credentials_body(a));
            credentials.push(String::new());
        }
    }
    let join = |lines: Vec<String>| if lines.is_empty() { String::new() } else { format!("{}\n", lines.join("\n").trim_end()) };
    (join(config), join(credentials))
}

fn session_name(a: &AwsAccess) -> String {
    let s = a.sso_session_name.trim();
    if s.is_empty() { "default".to_string() } else { s.to_string() }
}

fn sso_session_body(a: &AwsAccess) -> Vec<String> {
    let region = if a.sso_region.trim().is_empty() { a.region.trim() } else { a.sso_region.trim() };
    vec![
        format!("sso_start_url = {}", a.sso_start_url.trim()),
        format!("sso_region = {region}"),
        "sso_registration_scopes = sso:account:access".to_string(),
    ]
}

/// Les profils nommés de l'accès, ou `default` s'il n'en a aucun.
fn profiles_or_default(a: &AwsAccess) -> Vec<AwsProfileEntry> {
    let named: Vec<AwsProfileEntry> = a
        .profiles
        .iter()
        .filter(|p| !p.name.trim().is_empty())
        .map(|p| AwsProfileEntry { name: p.name.trim().to_string(), ..p.clone() })
        .collect();
    if named.is_empty() {
        vec![AwsProfileEntry { name: "default".into(), account_id: String::new(), role_name: String::new(), region: String::new(), extra: BTreeMap::new() }]
    } else {
        named
    }
}

fn profile_header(name: &str) -> String {
    if name == "default" { "[default]".to_string() } else { format!("[profile {name}]") }
}

fn profile_body(a: &AwsAccess, p: &AwsProfileEntry, session: &str) -> Vec<String> {
    let mut body = Vec::new();
    if a.auth_type == AwsAuthType::Sso {
        body.push(format!("sso_session = {session}"));
        if !p.account_id.trim().is_empty() {
            body.push(format!("sso_account_id = {}", p.account_id.trim()));
        }
        if !p.role_name.trim().is_empty() {
            body.push(format!("sso_role_name = {}", p.role_name.trim()));
        }
    } else if !a.mfa_serial.trim().is_empty() {
        body.push(format!("mfa_serial = {}", a.mfa_serial.trim()));
    }
    let region = if p.region.trim().is_empty() { a.region.trim() } else { p.region.trim() };
    if !region.is_empty() {
        body.push(format!("region = {region}"));
    }
    body
}

fn credentials_body(a: &AwsAccess) -> Vec<String> {
    vec![
        format!("aws_access_key_id = {}", a.access_key_id.trim()),
        format!("aws_secret_access_key = {}", a.secret_access_key.trim()),
    ]
}

// ─── Coffre → machine ───────────────────────────────────────────────────────

/// Ce que [`apply`] a écrit, pour le dire à l'utilisateur.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// La session SSO écrite, à connecter ensuite (`None` pour des clés).
    pub sso_session: Option<String>,
    pub profiles: Vec<String>,
    /// Des clés ont été écrites dans `~/.aws/credentials`.
    pub credentials: bool,
}

/// Écrit l'accès dans la configuration AWS de cette machine. Les sections
/// de même nom sont remplacées, tout le reste des fichiers est conservé.
pub fn apply(a: &AwsAccess) -> Result<Applied, AwsCliError> {
    let (config, credentials, applied) = apply_to(&aws_sso::read_config(), &aws_sso::read_file(aws_sso::credentials_path()), a)?;
    if let Some(credentials) = credentials {
        aws_sso::write_file(aws_sso::credentials_path(), &credentials)?;
    }
    aws_sso::write_config(&config)?;
    Ok(applied)
}

/// [`apply`] sans les fichiers : le nouveau `config`, le nouveau
/// `credentials` s'il change, et ce qui a été écrit.
pub fn apply_to(config: &str, credentials: &str, a: &AwsAccess) -> Result<(String, Option<String>, Applied), AwsCliError> {
    let refuse = |message: &str| AwsCliError::Unreadable { message: message.to_string() };
    let mut config = config.to_string();
    let mut new_credentials = None;
    let session = session_name(a);
    let profiles = profiles_or_default(a);
    match a.auth_type {
        AwsAuthType::Sso => {
            if a.sso_start_url.trim().is_empty() {
                return Err(refuse("cet accès AWS n'a pas d'URL de démarrage SSO"));
            }
            config = aws_sso::upsert_section(&config, &format!("sso-session {session}"), &sso_session_body(a));
        }
        AwsAuthType::Keys => {
            if a.access_key_id.trim().is_empty() || a.secret_access_key.trim().is_empty() {
                return Err(refuse("cet accès AWS n'a pas de clé d'accès complète"));
            }
            let mut c = credentials.to_string();
            for p in &profiles {
                c = aws_sso::upsert_section(&c, &p.name, &credentials_body(a));
            }
            new_credentials = Some(c);
        }
    }
    for p in &profiles {
        let header = profile_header(&p.name);
        let header = header.trim_start_matches('[').trim_end_matches(']');
        config = aws_sso::upsert_section(&config, header, &profile_body(a, p, &session));
    }
    let applied = Applied {
        sso_session: (a.auth_type == AwsAuthType::Sso).then_some(session),
        profiles: profiles.into_iter().map(|p| p.name).collect(),
        credentials: a.auth_type == AwsAuthType::Keys,
    };
    Ok((config, new_credentials, applied))
}

// ─── Machine → coffre ───────────────────────────────────────────────────────

/// Une session locale et ses profils, par-dessus ce que le coffre en savait
/// (`previous`) : nom, dossier, notes et profils d'autres postes gardés.
pub fn from_local(id: Uuid, session: &AwsSsoSession, profiles: &[AwsProfile], previous: Option<AwsAccess>) -> AwsAccess {
    let mut out = previous.unwrap_or_else(|| AwsAccess {
        base: SecretBase {
            id,
            name: format!("AWS — {}", session.name),
            group_id: None,
            tags: vec!["aws".into()],
            favorite: None,
            notes: None,
            fields: None,
            extra: BTreeMap::new(),
        },
        auth_type: AwsAuthType::Sso,
        sso_session_name: String::new(),
        sso_start_url: String::new(),
        sso_region: String::new(),
        access_key_id: String::new(),
        secret_access_key: String::new(),
        mfa_serial: String::new(),
        region: String::new(),
        profiles: Vec::new(),
    });
    out.auth_type = AwsAuthType::Sso;
    out.sso_session_name = session.name.clone();
    out.sso_start_url = session.start_url.clone();
    out.sso_region = session.region.clone();
    for p in profiles.iter().filter(|p| p.sso_session.as_deref() == Some(session.name.as_str())) {
        let entry = AwsProfileEntry {
            name: p.name.clone(),
            account_id: p.account_id.clone().unwrap_or_default(),
            role_name: p.role_name.clone().unwrap_or_default(),
            region: p.region.clone().unwrap_or_default(),
            extra: BTreeMap::new(),
        };
        match out.profiles.iter_mut().find(|x| x.name == entry.name) {
            Some(slot) => *slot = AwsProfileEntry { extra: std::mem::take(&mut slot.extra), ..entry },
            None => out.profiles.push(entry),
        }
    }
    out
}

/// Ce que [`save_session`] a fait.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub id: Uuid,
    pub vault_id: VaultId,
    pub vault_name: String,
    pub name: String,
    pub profiles: usize,
    /// Un item existant a été mis à jour (sinon : créé).
    pub updated: bool,
}

/// Enregistre dans le coffre la session SSO `name` de `~/.aws/config`.
pub async fn save_session(manager: &Manager, name: &str) -> anyhow::Result<Saved> {
    let session = aws_inventory::list_sso_sessions()
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("session SSO « {name} » absente de ~/.aws/config"))?;
    let profiles = aws_inventory::parse_config(&aws_sso::read_config());

    let client = manager.client()?;
    let _account = manager.account()?;
    let remote = client.sync().await.map_err(super::account::user_error)?;
    manager.update_session(|s| s.absorb_vaults(&remote.vaults))?;
    let vaults = manager.vault_infos();

    // Le même accès, s'il est déjà quelque part où l'on peut écrire.
    let mut found: Option<(super::account::VaultInfo, proto::Item, AwsAccess)> = None;
    for v in vaults.iter().filter(|v| v.role != Role::Reader) {
        let page = client.items(v.id, None).await.map_err(super::account::user_error)?;
        for item in page.items.into_iter().filter(|i| !i.deleted && i.item_type == TYPE_AWS) {
            let Ok(plain) = gc::open_item(&v.key, &v.id.to_string(), &item.id.to_string(), &item.item_type, &item.ciphertext) else { continue };
            let Ok(SecretItem::Aws { aws }) = SecretItem::from_json(&plain) else { continue };
            if aws.auth_type == AwsAuthType::Sso && aws.sso_start_url.trim() == session.start_url.trim() && aws.sso_session_name == session.name {
                found = Some((v.clone(), item, aws));
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }

    let (vault, id, base, previous) = match found {
        Some((v, item, aws)) => (v, item.id, Some(item.revision), Some(aws)),
        None => {
            let personal = vaults
                .iter()
                .find(|v| v.kind == VaultKind::Personal)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("ce compte n'a pas de vault personnel"))?;
            (personal, Uuid::new_v4(), None, None)
        }
    };
    let access = from_local(id, &session, &profiles, previous);
    let json = SecretItem::Aws { aws: access.clone() }.to_json()?;
    let ciphertext = gc::seal_item(&vault.key, &vault.id.to_string(), &id.to_string(), TYPE_AWS, json.as_bytes())
        .map_err(|e| anyhow::anyhow!("chiffrement : {e}"))?;
    client
        .put_item(vault.id, id, &proto::PutItemRequest { item_type: TYPE_AWS.to_string(), ciphertext, base_revision: base })
        .await
        .map_err(super::account::user_error)?;
    manager.persist_tokens();
    Ok(Saved {
        id,
        vault_id: vault.id,
        vault_name: vault.name,
        name: access.base.name,
        profiles: access.profiles.len(),
        updated: base.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> AwsSsoSession {
        AwsSsoSession { name: "org".into(), start_url: "https://org.awsapps.com/start".into(), region: "eu-west-1".into() }
    }

    fn profile(name: &str, session: Option<&str>, account: &str) -> AwsProfile {
        AwsProfile { name: name.into(), sso_session: session.map(Into::into), account_id: Some(account.into()), role_name: Some("Admin".into()), region: Some("eu-west-3".into()) }
    }

    #[test]
    fn a_local_session_becomes_an_item_with_only_its_own_profiles() {
        let id = Uuid::new_v4();
        let a = from_local(id, &session(), &[profile("prod", Some("org"), "111111111111"), profile("perso", None, "222222222222")], None);
        assert_eq!(a.base.id, id);
        assert_eq!(a.sso_start_url, "https://org.awsapps.com/start");
        assert_eq!(a.profiles.len(), 1, "un profil d'une autre session n'en fait pas partie");
        assert_eq!(a.profiles[0].account_id, "111111111111");
        // Relu tel que l'interface web l'écrit.
        let json = SecretItem::Aws { aws: a }.to_json().unwrap();
        assert!(json.contains(r#""kind":"aws""#) && json.contains(r#""ssoStartUrl""#), "{json}");
    }

    #[test]
    fn saving_again_keeps_what_the_vault_knew() {
        let mut previous = from_local(Uuid::new_v4(), &session(), &[profile("ailleurs", Some("org"), "333333333333")], None);
        previous.base.name = "Mon org".into();
        previous.base.notes = Some("note".into());
        let a = from_local(previous.base.id, &session(), &[profile("prod", Some("org"), "111111111111")], Some(previous));
        assert_eq!(a.base.name, "Mon org");
        assert_eq!(a.base.notes.as_deref(), Some("note"));
        let names: Vec<_> = a.profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["ailleurs", "prod"]);
    }

    #[test]
    fn the_config_text_matches_the_web_ui() {
        let a = from_local(Uuid::new_v4(), &session(), &[profile("prod", Some("org"), "123456789012")], None);
        let (config, credentials) = config_text(&a);
        assert_eq!(
            config,
            "[sso-session org]\nsso_start_url = https://org.awsapps.com/start\nsso_region = eu-west-1\nsso_registration_scopes = sso:account:access\n\n[profile prod]\nsso_session = org\nsso_account_id = 123456789012\nsso_role_name = Admin\nregion = eu-west-3\n"
        );
        assert!(credentials.is_empty());
    }

    #[test]
    fn applying_replaces_only_its_own_sections() {
        let a = from_local(Uuid::new_v4(), &session(), &[profile("prod", Some("org"), "123456789012")], None);
        let before = "# mes réglages\n[profile autre]\nregion = us-east-1\ncredential_process = /bin/x\n\n[profile prod]\nregion = ancien\n";
        let (config, credentials, applied) = apply_to(before, "", &a).unwrap();
        assert!(config.contains("# mes réglages") && config.contains("credential_process = /bin/x"), "le reste survit : {config}");
        assert!(config.contains("[sso-session org]") && config.contains("sso_account_id = 123456789012"), "{config}");
        assert!(!config.contains("region = ancien"), "la section du même nom est remplacée : {config}");
        assert!(credentials.is_none(), "une session SSO ne touche pas ~/.aws/credentials");
        assert_eq!(applied.sso_session.as_deref(), Some("org"));
        assert_eq!(applied.profiles, ["prod"]);

        let mut empty = a.clone();
        empty.sso_start_url.clear();
        assert!(apply_to("", "", &empty).is_err());
    }

    #[test]
    fn keys_go_to_credentials_not_config() {
        let mut a = from_local(Uuid::new_v4(), &session(), &[], None);
        a.auth_type = AwsAuthType::Keys;
        a.access_key_id = "AKIA1".into();
        a.secret_access_key = "s3cr3t".into();
        let (config, credentials) = config_text(&a);
        assert!(config.starts_with("[default]") && !config.contains("s3cr3t"), "{config}");
        assert_eq!(credentials, "[default]\naws_access_key_id = AKIA1\naws_secret_access_key = s3cr3t\n");
    }
}
