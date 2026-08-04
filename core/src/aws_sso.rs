//! Setting up AWS IAM Identity Center (SSO) access, without a terminal.
//!
//! **Why this doesn't drive `aws configure sso`.** That wizard is not a
//! questionnaire: after the browser step it picks the account and the role
//! through arrow-key menus whose rendering is not an API contract, and whose
//! behaviour changes with how many accounts you can see. Feeding it keystrokes
//! would work until a CLI release moved a line.
//!
//! Everything the wizard does is available piecemeal and non-interactively,
//! which is what this module uses instead:
//!
//! 1. the `[sso-session]` block is written straight into `~/.aws/config`,
//! 2. `aws sso login --sso-session X` runs the device-authorisation flow — one
//!    linear stream of output, no menu,
//! 3. `aws sso list-accounts` / `list-account-roles` enumerate what the login
//!    grants, for a real list in the app rather than a menu piloted blind,
//! 4. `[profile …]` blocks are written for whatever was picked.
//!
//! The result is also *the same configuration the CLI itself would have
//! written*, so `aws`, `terraform` and everything else on the machine see it
//! too — and renewing an expired session is just step 2 again, which is what
//! makes "reconnect" a button rather than a wizard.

use crate::aws_inventory::{AwsCliError, run_aws};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

/// `~/.aws/config`, the file the CLI itself reads.
pub fn config_path() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".aws").join("config"))
}

fn sso_cache_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".aws").join("sso").join("cache"))
}

/// Inserts or replaces one `[header]` section in an INI-style file, leaving
/// every other byte alone.
///
/// Rewriting the whole file from a parsed model would be simpler and wrong:
/// `~/.aws/config` belongs to the user and to every other tool on the machine,
/// and carries settings this app neither reads nor understands
/// (`credential_process`, `role_arn`, `s3 =` sub-sections, comments). Only the
/// section being changed is touched; anything else survives byte for byte.
pub fn upsert_section(content: &str, header: &str, body: &[String]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut skipping = false;
    let mut replaced = false;
    let wanted = format!("[{header}]");

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            // A new section header always ends any skipping — including the
            // one we came to replace.
            skipping = trimmed == wanted;
            if skipping {
                out.push(wanted.clone());
                out.extend(body.iter().cloned());
                replaced = true;
                continue;
            }
        }
        if !skipping {
            out.push(line.to_string());
        }
    }

    if !replaced {
        if out.last().is_some_and(|last| !last.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(wanted);
        out.extend(body.iter().cloned());
    }

    let mut text = out.join("\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

fn read_config() -> String {
    config_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default()
}

fn write_config(content: &str) -> Result<(), AwsCliError> {
    let path = config_path().ok_or_else(|| AwsCliError::Unreadable {
        message: "impossible de déterminer le dossier personnel".to_string(),
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AwsCliError::Unreadable {
            message: format!("impossible de créer {} : {e}", parent.display()),
        })?;
    }
    // Atomic, like every other config write in this app: a half-written
    // `~/.aws/config` would break every AWS tool on the machine, not just this
    // one.
    crate::secure_file::write_private(&path, content.as_bytes()).map_err(|e| {
        AwsCliError::Unreadable {
            message: format!("écriture de {} impossible : {e}", path.display()),
        }
    })
}

/// Writes (or updates) an `[sso-session]` block.
pub fn save_session(name: &str, start_url: &str, region: &str) -> Result<(), AwsCliError> {
    let body = vec![
        format!("sso_start_url = {start_url}"),
        format!("sso_region = {region}"),
        // The scope the account/role listing needs. `aws configure sso` writes
        // the same one.
        "sso_registration_scopes = sso:account:access".to_string(),
    ];
    let updated = upsert_section(&read_config(), &format!("sso-session {name}"), &body);
    write_config(&updated)
}

/// One profile to create for an (account, role) pair.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSpec {
    pub name: String,
    pub session: String,
    pub account_id: String,
    pub role_name: String,
    pub region: String,
}

pub fn save_profiles(profiles: &[ProfileSpec]) -> Result<(), AwsCliError> {
    let mut content = read_config();
    for profile in profiles {
        let body = vec![
            format!("sso_session = {}", profile.session),
            format!("sso_account_id = {}", profile.account_id),
            format!("sso_role_name = {}", profile.role_name),
            format!("region = {}", profile.region),
            "output = json".to_string(),
        ];
        content = upsert_section(&content, &format!("profile {}", profile.name), &body);
    }
    write_config(&content)
}

/// Runs `aws sso login`, reporting its output line by line as it arrives.
///
/// Streamed rather than collected because the interesting part comes *during*
/// the wait: the CLI prints a verification URL and a code, opens a browser,
/// and then blocks until the user has finished. Showing those two lines is
/// what makes the wait comprehensible — and it is the only way through when
/// no browser can open.
pub async fn login(
    session: &str,
    on_line: &mut (dyn FnMut(String) + Send),
) -> Result<(), AwsCliError> {
    let mut command = tokio::process::Command::new("aws");
    command
        .args(["sso", "login", "--sso-session", session])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(AwsCliError::CliMissing),
        Err(e) => {
            return Err(AwsCliError::Unreadable {
                message: format!("`aws sso login` n'a pas pu être lancée : {e}"),
            });
        }
    };

    // Both streams matter: the CLI has moved the verification URL between
    // stdout and stderr across versions, and reading only one has therefore
    // shown an empty wait to some users.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for stream in [
        stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut transcript = Vec::new();
    while let Some(line) = rx.recv().await {
        transcript.push(line.clone());
        on_line(line);
    }

    let status = child.wait().await.map_err(|e| AwsCliError::Unreadable {
        message: format!("`aws sso login` s'est terminée anormalement : {e}"),
    })?;
    if status.success() {
        return Ok(());
    }
    Err(crate::aws_inventory::classify_failure(&transcript.join("\n")))
}

/// An access token from the CLI's own SSO cache.
///
/// Read rather than obtained ourselves: performing the device flow here would
/// mean a second token, invisible to the CLI and expiring on its own schedule.
/// Reusing the CLI's means one login serves every tool on the machine, which
/// is the whole point of writing real config instead of keeping our own.
/// Picks this session's access token out of a set of cache documents.
///
/// Most files in that directory are *client registrations* and carry no token
/// at all — only `clientId`/`clientSecret`. Skipping them is the entire job,
/// and getting it wrong looks exactly like never having logged in.
///
/// Matched on the start URL or the session name, because which one the CLI
/// writes depends on how the session was configured, and a token found under
/// the wrong key is a token not found.
pub fn pick_access_token<'a>(
    documents: impl IntoIterator<Item = &'a str>,
    start_url: &str,
    session: &str,
) -> Option<String> {
    for text in documents {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        // `continue`, never `?`: one registration file must not end the
        // search. It did, which is why a successful login still reported "no
        // token in cache".
        let Some(token) = value["accessToken"].as_str() else {
            continue;
        };
        let matches = value["startUrl"].as_str() == Some(start_url)
            || value["sessionName"].as_str() == Some(session);
        if matches {
            return Some(token.to_string());
        }
    }
    None
}

fn cached_access_token(start_url: &str, session: &str) -> Option<String> {
    let dir = sso_cache_dir()?;
    let documents: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect();
    pick_access_token(documents.iter().map(String::as_str), start_url, session)
}

/// An account the signed-in user can reach, with the roles available in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoAccount {
    pub account_id: String,
    pub name: String,
    pub email: Option<String>,
    pub roles: Vec<String>,
}

pub fn parse_accounts(json: &str) -> Result<Vec<(String, String, Option<String>)>, AwsCliError> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
            message: format!("réponse list-accounts illisible : {e}"),
        })?;
    Ok(parsed["accountList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    Some((
                        entry["accountId"].as_str()?.to_string(),
                        entry["accountName"].as_str().unwrap_or("").to_string(),
                        entry["emailAddress"].as_str().map(str::to_string),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

pub fn parse_roles(json: &str) -> Result<Vec<String>, AwsCliError> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
            message: format!("réponse list-account-roles illisible : {e}"),
        })?;
    Ok(parsed["roleList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry["roleName"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// Lists every account the session grants, each with its roles.
pub async fn list_accounts(
    start_url: &str,
    region: &str,
    session: &str,
) -> Result<Vec<SsoAccount>, AwsCliError> {
    let token = cached_access_token(start_url, session).ok_or_else(|| AwsCliError::Refused {
        message: "Aucun jeton SSO en cache pour cette session.".to_string(),
        hint: Some("Se connecter d'abord — la session n'a jamais été ouverte, ou son jeton a été effacé.".to_string()),
        // Reconnecting is exactly the fix here.
        session_expired: true,
    })?;

    let listing = run_aws(&[
        "sso",
        "list-accounts",
        "--access-token",
        &token,
        "--region",
        region,
        "--output",
        "json",
    ])
    .await?;

    let mut accounts = Vec::new();
    for (account_id, name, email) in parse_accounts(&listing)? {
        let roles_json = run_aws(&[
            "sso",
            "list-account-roles",
            "--access-token",
            &token,
            "--account-id",
            &account_id,
            "--region",
            region,
            "--output",
            "json",
        ])
        .await
        // An account whose roles can't be listed is still worth showing, with
        // none: hiding it would look like the account itself is missing.
        .unwrap_or_default();
        accounts.push(SsoAccount {
            roles: parse_roles(&roles_json).unwrap_or_default(),
            account_id,
            name,
            email,
        });
    }
    accounts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXISTING: &str = "\
[default]\nregion = us-east-1\n\n\
[sso-session ma-boite]\nsso_start_url = https://ancien.example/start\nsso_region = us-east-1\n\n\
[profile garde-moi]\nsso_session = ma-boite\nregion = eu-west-1\ncredential_process = /usr/bin/truc\n";

    #[test]
    fn replaces_an_existing_section_in_place() {
        let updated = upsert_section(
            EXISTING,
            "sso-session ma-boite",
            &["sso_start_url = https://neuf.example/start".to_string()],
        );
        assert!(updated.contains("https://neuf.example/start"));
        assert!(!updated.contains("https://ancien.example/start"));
        assert!(!updated.contains("sso_region = us-east-1\n\n[profile"), "l'ancien corps doit disparaître");
    }

    /// The file belongs to the user and to every other AWS tool. Anything this
    /// app doesn't understand — `credential_process` here — has to survive
    /// untouched, or configuring SSO would quietly break the rest of someone's
    /// setup.
    #[test]
    fn leaves_every_other_section_byte_for_byte() {
        let updated = upsert_section(EXISTING, "sso-session ma-boite", &["sso_region = eu-west-3".to_string()]);
        assert!(updated.contains("[default]\nregion = us-east-1"));
        assert!(updated.contains("[profile garde-moi]"));
        assert!(updated.contains("credential_process = /usr/bin/truc"));
    }

    #[test]
    fn appends_a_section_that_does_not_exist_yet() {
        let updated = upsert_section(EXISTING, "profile neuf", &["region = eu-west-3".to_string()]);
        assert!(updated.contains("[profile neuf]\nregion = eu-west-3"));
        assert!(updated.contains("[profile garde-moi]"));
    }

    #[test]
    fn writes_into_an_empty_file() {
        let updated = upsert_section("", "sso-session x", &["sso_region = eu-west-3".to_string()]);
        assert_eq!(updated, "[sso-session x]\nsso_region = eu-west-3\n");
    }

    /// Two sections in a row: replacing the first must not swallow the second,
    /// which is what a "skip until blank line" implementation would do.
    #[test]
    fn a_replaced_section_ends_at_the_next_header_not_at_a_blank_line() {
        let content = "[a]\nx = 1\ny = 2\n[b]\nz = 3\n";
        let updated = upsert_section(content, "a", &["x = 9".to_string()]);
        assert!(updated.contains("[b]\nz = 3"));
        assert!(!updated.contains("y = 2"));
    }

    /// The shape that broke it: the cache directory holds several client
    /// registrations (no token at all) and one token document, and the
    /// registrations come first. An early `?` on the missing field ended the
    /// whole search there — so a login that had just succeeded reported no
    /// token.
    #[test]
    fn finds_the_token_past_the_client_registration_files() {
        let registration = r#"{"clientId":"a","clientSecret":"b","expiresAt":"2026-01-01T00:00:00Z"}"#;
        let token = r#"{"accessToken":"le-jeton","startUrl":"https://ma-boite.awsapps.com/start","region":"eu-west-3"}"#;
        assert_eq!(
            pick_access_token([registration, registration, token], "https://ma-boite.awsapps.com/start", "ma-boite"),
            Some("le-jeton".to_string())
        );
    }

    /// Which key ties the token to the session depends on how the CLI wrote
    /// it; a token found under the wrong one is a token not found.
    #[test]
    fn matches_on_the_session_name_as_well_as_the_start_url() {
        let by_session = r#"{"accessToken":"jeton-2","sessionName":"ma-boite"}"#;
        assert_eq!(
            pick_access_token([by_session], "https://autre.example/start", "ma-boite"),
            Some("jeton-2".to_string())
        );
    }

    #[test]
    fn ignores_a_token_belonging_to_another_session() {
        let other = r#"{"accessToken":"pas-le-mien","startUrl":"https://autre.example/start"}"#;
        assert_eq!(pick_access_token([other], "https://ma-boite.awsapps.com/start", "ma-boite"), None);
    }

    #[test]
    fn survives_an_unparsable_cache_file() {
        let token = r#"{"accessToken":"ok","startUrl":"https://x/start"}"#;
        assert_eq!(pick_access_token(["pas du json", token], "https://x/start", "x"), Some("ok".to_string()));
    }

    #[test]
    fn reads_the_account_listing() {
        let json = r#"{"accountList":[
            {"accountId":"167004607868","accountName":"prod","emailAddress":"aws+prod@example.com"},
            {"accountId":"999999999999","accountName":"dev"}
        ]}"#;
        let accounts = parse_accounts(json).unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].0, "167004607868");
        assert_eq!(accounts[0].1, "prod");
        assert_eq!(accounts[1].2, None);
    }

    #[test]
    fn reads_the_role_listing() {
        let json = r#"{"roleList":[{"roleName":"AdministratorAccess","accountId":"1"},{"roleName":"ReadOnly","accountId":"1"}]}"#;
        assert_eq!(parse_roles(json).unwrap(), vec!["AdministratorAccess", "ReadOnly"]);
    }

    #[test]
    fn an_empty_listing_is_not_an_error() {
        assert!(parse_accounts(r#"{"accountList":[]}"#).unwrap().is_empty());
        assert!(parse_roles(r#"{}"#).unwrap().is_empty());
    }
}
