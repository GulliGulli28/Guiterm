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

/// Removes one `[header]` section, leaving every other byte alone.
///
/// The mirror image of [`upsert_section`], and it inherits the same promise:
/// this file belongs to the user and to every other AWS tool on the machine.
///
/// The blank lines that followed the section go with it — they separated it
/// from the next one, and keeping them would make the file grow a hole every
/// time something is deleted. The blank line *before* it stays, because it
/// belongs to whatever comes before.
pub fn delete_section(content: &str, header: &str) -> String {
    let wanted = format!("[{header}]");
    let mut out: Vec<String> = Vec::new();
    let mut skipping = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping = trimmed == wanted;
            if skipping {
                continue;
            }
        }
        if !skipping {
            out.push(line.to_string());
        }
    }

    let mut text = out.join("\n");
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// The section header a profile is written under.
///
/// `default` is the exception the CLI itself makes: it is `[default]`, never
/// `[profile default]`, and getting this wrong deletes nothing while reporting
/// success.
fn profile_header(name: &str) -> String {
    if name == "default" {
        "default".to_string()
    } else {
        format!("profile {name}")
    }
}

/// `~/.aws/credentials` — the *other* file the CLI reads.
///
/// Profiles defined there use a bare `[name]` header (no `profile ` prefix),
/// and `aws configure list-profiles` lists them alongside the config ones. A
/// deletion that only touched `~/.aws/config` would therefore leave the profile
/// in the picker and look like it silently failed.
fn credentials_path() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".aws").join("credentials"))
}

/// Deletes a profile from both files the CLI reads.
///
/// Not an error when the profile is in neither: the caller's intent is "make
/// this go away", and it already has.
pub fn delete_profile(name: &str) -> Result<(), AwsCliError> {
    let header = profile_header(name);
    if let Some(path) = config_path() {
        rewrite_without_section(&path, &header)?;
    }
    if let Some(path) = credentials_path() {
        // Bare `[name]` here, and the file holds real secrets — hence the same
        // atomic 0600 write as everything else.
        rewrite_without_section(&path, name)?;
    }
    Ok(())
}

/// Deletes an `[sso-session]` block.
///
/// The profiles that pointed at it are left alone on purpose: deleting
/// someone's profiles as a side effect of removing a login would be a
/// surprise, and the panel says how many are affected before asking.
pub fn delete_sso_session(name: &str) -> Result<(), AwsCliError> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    rewrite_without_section(&path, &format!("sso-session {name}"))
}

fn rewrite_without_section(path: &std::path::Path, header: &str) -> Result<(), AwsCliError> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let updated = delete_section(&content, header);
    if updated == content {
        return Ok(());
    }
    crate::secure_file::write_private(path, updated.as_bytes()).map_err(|e| {
        AwsCliError::Unreadable {
            message: format!("écriture de {} impossible : {e}", path.display()),
        }
    })
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
pub fn pick_token<'a>(
    documents: impl IntoIterator<Item = &'a str>,
    start_url: &str,
    session: &str,
) -> Option<CachedToken> {
    let mut best: Option<(u8, i64, CachedToken)> = None;
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
        let by_session = value["sessionName"].as_str() == Some(session);
        let by_url = value["startUrl"].as_str() == Some(start_url);
        if !by_session && !by_url {
            continue;
        }
        let expires_at = value["expiresAt"].as_str().map(str::to_string);
        // Two levels, both learned from a real cache directory: the session
        // name identifies exactly one session, while several sessions of the
        // same Identity Center instance share a start URL — and the cache
        // keeps every token it has ever written, so "the first one that
        // matches" is very often an hour-old one. Which is what reported every
        // session as expired, and sent a dead token to `list-accounts`.
        let rank = (
            u8::from(by_session),
            expires_at.as_deref().and_then(parse_expiry).unwrap_or(i64::MIN),
        );
        if best.as_ref().is_none_or(|(session_match, expiry, _)| rank > (*session_match, *expiry)) {
            best = Some((
                rank.0,
                rank.1,
                CachedToken {
                    access_token: token.to_string(),
                    refreshable: value["refreshToken"].as_str().is_some(),
                    expires_at,
                },
            ));
        }
    }
    best.map(|(_, _, token)| token)
}

/// What the CLI's cache holds for one session.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedToken {
    pub access_token: String,
    /// As written, because the CLI has used more than one format for it (see
    /// [`parse_expiry`]). Kept verbatim so an unparsable one can still be
    /// shown rather than silently becoming "never logged in".
    pub expires_at: Option<String>,
    /// A refresh token sits next to it, so the CLI can mint a new access token
    /// without a browser. Access tokens last an hour while an Identity Center
    /// session lasts hours or days — so "expired" here is the *normal* state
    /// of a perfectly usable session, and calling it a dead one would be
    /// wrong far more often than right.
    pub refreshable: bool,
}

pub fn pick_access_token<'a>(
    documents: impl IntoIterator<Item = &'a str>,
    start_url: &str,
    session: &str,
) -> Option<String> {
    pick_token(documents, start_url, session).map(|cached| cached.access_token)
}

fn cached_documents() -> Vec<String> {
    sso_cache_dir()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn cached_token(start_url: &str, session: &str) -> Option<CachedToken> {
    let documents = cached_documents();
    pick_token(documents.iter().map(String::as_str), start_url, session)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether a cached token can still be sent to the SSO API.
///
/// An unreadable expiry counts as usable: the alternative is refusing to try a
/// token that is probably fine, and the API's own answer is more authoritative
/// than our parser anyway.
fn is_usable(token: &CachedToken) -> bool {
    token
        .expires_at
        .as_deref()
        .and_then(parse_expiry)
        .is_none_or(|at| at > now_secs())
}

/// The first profile that signs in through this session, if any.
fn profile_for_session(session: &str) -> Option<String> {
    crate::aws_inventory::parse_config(&read_config())
        .into_iter()
        .find(|profile| profile.sso_session.as_deref() == Some(session))
        .map(|profile| profile.name)
}

/// Gets the CLI to mint a fresh access token from the refresh token it holds.
///
/// There is no `aws sso refresh`: renewal only happens as a side effect of the
/// CLI resolving credentials for a profile, which then rewrites the cache
/// document. So this asks for the cheapest call that does that — the same
/// `get-caller-identity` the panel's check button uses, needing no permission
/// beyond being authenticated.
///
/// Worth the round trip because an access token lives one hour while the
/// session behind it lives a day or more: without this, adding a profile to a
/// session signed in this morning would demand a pointless browser trip.
async fn renew_via_profile(session: &str) -> bool {
    let Some(profile) = profile_for_session(session) else {
        return false;
    };
    crate::aws_inventory::whoami(&profile).await.is_ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`). Vendored rather than pulled in: this is the only date
/// arithmetic in the whole crate, and a date library would be a dependency
/// bought for eight lines.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Unix seconds for an `expiresAt` out of the SSO cache.
///
/// Hand-rolled because the CLI has written this field at least three ways —
/// `2026-08-04T18:14:32Z` today, `2026-08-04T18:14:32UTC` in older botocore
/// releases, and offsets or fractional seconds depending on the path taken.
/// A parser that accepted only today's shape would report a perfectly valid
/// session as expired, which is worse than showing no countdown at all: it
/// would send someone re-authenticating for nothing.
///
/// Anything unrecognisable yields `None`, and the caller treats that as
/// "logged in, expiry unknown" rather than as an expiry.
pub fn parse_expiry(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (date, rest) = raw.split_once('T').or_else(|| raw.split_once(' '))?;
    let mut fields = date.split('-');
    let year: i64 = fields.next()?.parse().ok()?;
    let month: i64 = fields.next()?.parse().ok()?;
    let day: i64 = fields.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // The time ends where the zone marker starts: `Z`, `UTC`, or a signed
    // offset. `find('-')` only after the others, since a time itself never
    // contains one.
    let end = rest
        .find(['Z', 'z', '+', 'U', 'u'])
        .or_else(|| rest.find('-'))
        .unwrap_or(rest.len());
    let (time, zone) = rest.split_at(end);
    // Fractional seconds carry no information at this resolution.
    let mut clock = time.split('.').next()?.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: i64 = clock.next().unwrap_or("0").parse().ok()?;

    let offset = parse_offset(zone)?;
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second - offset)
}

/// Seconds to subtract to reach UTC. `Z`, `UTC` and an absent marker are all
/// zero — the CLI writes UTC in every shape it uses.
fn parse_offset(zone: &str) -> Option<i64> {
    let zone = zone.trim();
    let sign = match zone.chars().next() {
        None => return Some(0),
        Some('Z' | 'z') => return Some(0),
        Some('U' | 'u') => return Some(0),
        Some('+') => 1,
        Some('-') => -1,
        Some(_) => return None,
    };
    let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
    let (hours, minutes) = match digits.len() {
        2 => (digits.parse::<i64>().ok()?, 0),
        4 => (digits[..2].parse::<i64>().ok()?, digits[2..].parse::<i64>().ok()?),
        _ => return None,
    };
    Some(sign * (hours * 3_600 + minutes * 60))
}

/// Whether a session can be used right now, and for how much longer.
///
/// A tagged union rather than a pair of booleans because the three cases have
/// genuinely different remedies — sign in, sign in again, nothing — and the
/// frontend closes the `switch` with `assertNever`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SsoSessionState {
    /// Nothing in the CLI's cache: never signed in, or the cache was cleared.
    NeverLoggedIn,
    /// The access token has lapsed but a refresh token is cached: the CLI will
    /// mint a new one by itself, with no browser, for as long as the Identity
    /// Center session lives. Kept apart from [`Self::Expired`] because access
    /// tokens last an hour and sessions last a day — showing "expired" for
    /// this was the first thing anyone noticed, and it was wrong: the profiles
    /// underneath answered perfectly well.
    Renewable { expires_at: String },
    /// Lapsed with nothing to renew it from. Signing in again is the only fix.
    Expired { expires_at: String },
    /// A token is cached and hasn't expired. `expires_at` is `None` when the
    /// cache document carried no readable expiry — usable, just no countdown.
    Valid {
        expires_at: Option<String>,
        seconds_left: Option<i64>,
    },
}

/// An `[sso-session]` block plus whether it is currently signed in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoSessionStatus {
    pub name: String,
    pub start_url: String,
    pub region: String,
    pub state: SsoSessionState,
}

/// Reads the state of one session out of a set of cache documents.
///
/// `now` is passed in rather than read here so the three branches are testable
/// without waiting for a token to expire.
pub fn session_state<'a>(
    documents: impl IntoIterator<Item = &'a str>,
    start_url: &str,
    session: &str,
    now: i64,
) -> SsoSessionState {
    let Some(token) = pick_token(documents, start_url, session) else {
        return SsoSessionState::NeverLoggedIn;
    };
    let Some(raw) = token.expires_at else {
        return SsoSessionState::Valid {
            expires_at: None,
            seconds_left: None,
        };
    };
    match parse_expiry(&raw) {
        Some(at) if at <= now && token.refreshable => SsoSessionState::Renewable { expires_at: raw },
        Some(at) if at <= now => SsoSessionState::Expired { expires_at: raw },
        Some(at) => SsoSessionState::Valid {
            seconds_left: Some(at - now),
            expires_at: Some(raw),
        },
        // Unreadable expiry: the token is there, so it is not "never logged
        // in", and calling it expired would send someone signing in for
        // nothing.
        None => SsoSessionState::Valid {
            expires_at: Some(raw),
            seconds_left: None,
        },
    }
}

/// Every session in `~/.aws/config`, with its current sign-in state.
///
/// Reads two local files and nothing else: the panel that lists identities
/// must open instantly and work offline, and an expired session is exactly the
/// case where a network call would hang.
pub fn list_status() -> Vec<SsoSessionStatus> {
    let documents = cached_documents();
    let now = now_secs();
    crate::aws_inventory::list_sso_sessions()
        .into_iter()
        .map(|session| SsoSessionStatus {
            state: session_state(
                documents.iter().map(String::as_str),
                &session.start_url,
                &session.name,
                now,
            ),
            name: session.name,
            start_url: session.start_url,
            region: session.region,
        })
        .collect()
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
    let mut cached = cached_token(start_url, session);
    // A lapsed access token is the ordinary state of a session signed in more
    // than an hour ago, not a dead one — let the CLI renew it before giving
    // up. Sending it anyway is what produced "Session token not found or
    // invalid" right after a successful browser login.
    if !cached.as_ref().is_some_and(is_usable) {
        if renew_via_profile(session).await {
            cached = cached_token(start_url, session);
        }
        cached = cached.filter(is_usable);
    }
    let token = cached
        .map(|token| token.access_token)
        .ok_or_else(|| AwsCliError::Refused {
            message: "Le jeton SSO de cette session n'est pas utilisable.".to_string(),
            hint: Some(
                "Se reconnecter : la session n'a jamais été ouverte, ou son jeton a expiré \
                 sans pouvoir être renouvelé tout seul."
                    .to_string(),
            ),
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
    accounts.sort_by_key(|account| account.name.to_lowercase());
    Ok(accounts)
}

/// Account id → human name, for every SSO session that currently has a
/// usable token.
///
/// Best effort on purpose, and never fatal: an account number tells nobody
/// anything, but failing to resolve one must not stop a profile from being
/// selectable. A session whose token has expired simply contributes nothing,
/// and the caller falls back to showing the id.
///
/// One call per session rather than per profile — several profiles usually
/// share a session, and per-profile lookups would multiply a round trip that
/// answers the same question.
pub async fn account_names() -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    for session in crate::aws_inventory::list_sso_sessions() {
        if session.start_url.is_empty() || session.region.is_empty() {
            continue;
        }
        let Ok(accounts) = list_accounts(&session.start_url, &session.region, &session.name).await
        else {
            continue;
        };
        for account in accounts {
            if !account.name.is_empty() {
                names.insert(account.account_id, account.name);
            }
        }
    }
    names
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

    #[test]
    fn deletes_a_section_and_leaves_the_rest_alone() {
        let updated = delete_section(EXISTING, "sso-session ma-boite");
        assert!(!updated.contains("[sso-session ma-boite]"));
        assert!(!updated.contains("ancien.example"), "le corps part avec l'en-tête");
        assert!(updated.contains("[default]\nregion = us-east-1"));
        assert!(updated.contains("credential_process = /usr/bin/truc"));
    }

    /// The section's own trailing blank lines go with it. Keeping them would
    /// make the file gain a hole at every deletion.
    #[test]
    fn a_deletion_does_not_leave_a_growing_gap() {
        let updated = delete_section(EXISTING, "sso-session ma-boite");
        assert!(!updated.contains("\n\n\n"), "obtenu :\n{updated}");
    }

    #[test]
    fn deleting_a_section_that_is_not_there_changes_nothing() {
        assert_eq!(delete_section(EXISTING, "profile inexistant"), EXISTING);
    }

    #[test]
    fn deleting_the_last_section_leaves_the_earlier_ones() {
        let updated = delete_section(EXISTING, "profile garde-moi");
        assert!(!updated.contains("[profile garde-moi]"));
        assert!(updated.contains("[sso-session ma-boite]"));
    }

    /// `[default]`, never `[profile default]` — the CLI's own exception, and
    /// getting it wrong deletes nothing while reporting success.
    #[test]
    fn the_default_profile_has_no_profile_prefix() {
        assert_eq!(profile_header("default"), "default");
        assert_eq!(profile_header("prod"), "profile prod");
        let updated = delete_section(EXISTING, &profile_header("default"));
        assert!(!updated.contains("[default]"));
        assert!(updated.contains("[sso-session ma-boite]"));
    }

    /// The format the CLI writes today, plus the ones it has written before.
    /// Accepting only the current one would report a valid session as expired.
    #[test]
    fn reads_every_expiry_format_the_cli_has_written() {
        let reference = 1_775_326_472; // 2026-04-04T18:14:32Z
        assert_eq!(parse_expiry("2026-04-04T18:14:32Z"), Some(reference));
        assert_eq!(parse_expiry("2026-04-04T18:14:32UTC"), Some(reference), "botocore historique");
        assert_eq!(parse_expiry("2026-04-04T18:14:32.123Z"), Some(reference), "secondes fractionnaires");
        assert_eq!(parse_expiry("2026-04-04T20:14:32+02:00"), Some(reference), "décalage positif");
        assert_eq!(parse_expiry("2026-04-04T16:14:32-02:00"), Some(reference), "décalage négatif");
    }

    #[test]
    fn an_unreadable_expiry_is_none_rather_than_a_wrong_date() {
        assert_eq!(parse_expiry(""), None);
        assert_eq!(parse_expiry("bientôt"), None);
        assert_eq!(parse_expiry("2026-04-04"), None);
        assert_eq!(parse_expiry("2026-13-04T18:14:32Z"), None);
    }

    const TOKEN_VALID: &str = r#"{"accessToken":"t","startUrl":"https://x/start","expiresAt":"2026-04-04T18:14:32Z"}"#;

    /// The shape that broke it, taken from a real cache directory: access
    /// tokens last an hour, the CLI never deletes the old documents, and
    /// several sessions of the same Identity Center instance share a start
    /// URL. Taking the first match therefore hands out an hours-old token —
    /// which reported every session as expired and made `list-accounts` answer
    /// "Session token not found or invalid" *right after a successful login*.
    #[test]
    fn picks_the_freshest_of_several_tokens_sharing_a_start_url() {
        const URL: &str = "https://identitycenter.amazonaws.com/ssoins-6656330dd42c431b";
        let stale = format!(r#"{{"accessToken":"vieux","startUrl":"{URL}","expiresAt":"2026-04-04T09:21:09Z"}}"#);
        let older = format!(r#"{{"accessToken":"encore-plus-vieux","startUrl":"{URL}","expiresAt":"2026-04-04T09:20:43Z"}}"#);
        let fresh = format!(r#"{{"accessToken":"frais","startUrl":"{URL}","expiresAt":"2026-04-04T18:14:32Z"}}"#);
        // Stale ones first: that is exactly the order `read_dir` gave, and
        // taking the first match is what shipped.
        let picked = pick_token([stale.as_str(), older.as_str(), fresh.as_str()], URL, "peu-importe");
        assert_eq!(picked.unwrap().access_token, "frais");
    }

    /// A session name identifies one session; a start URL is shared by all the
    /// sessions of an Identity Center instance. The specific one wins even when
    /// a shared-URL document expires later.
    #[test]
    fn an_exact_session_match_beats_a_shared_start_url() {
        let shared = r#"{"accessToken":"partagé","startUrl":"https://x/start","expiresAt":"2030-01-01T00:00:00Z"}"#;
        let mine = r#"{"accessToken":"le-mien","sessionName":"ma-session","expiresAt":"2026-04-04T18:14:32Z"}"#;
        let picked = pick_token([shared, mine], "https://x/start", "ma-session");
        assert_eq!(picked.unwrap().access_token, "le-mien");
    }

    /// An access token lives an hour, the session behind it a day or more. A
    /// lapsed one with a refresh token next to it is the *ordinary* state of a
    /// working session — the CLI renews it silently, which is why the profiles
    /// underneath answered fine while the panel claimed the session had
    /// expired.
    #[test]
    fn a_refreshable_token_is_renewable_rather_than_expired() {
        let refreshable = r#"{"accessToken":"t","refreshToken":"r","startUrl":"https://x/start","expiresAt":"2026-04-04T18:14:32Z"}"#;
        let after = 1_775_326_472 + 60;
        assert_eq!(
            session_state([refreshable], "https://x/start", "x", after),
            SsoSessionState::Renewable { expires_at: "2026-04-04T18:14:32Z".to_string() }
        );
        // Without one, nothing can renew it and signing in again is the only
        // way out — the two must not read the same.
        assert!(matches!(
            session_state([TOKEN_VALID], "https://x/start", "x", after),
            SsoSessionState::Expired { .. }
        ));
    }

    #[test]
    fn the_json_carries_the_renewable_state() {
        let json = serde_json::to_value(SsoSessionState::Renewable {
            expires_at: "2026-04-04T18:14:32Z".to_string(),
        })
        .unwrap();
        assert_eq!(json["kind"], "renewable");
        assert_eq!(json["expiresAt"], "2026-04-04T18:14:32Z");
    }

    #[test]
    fn tells_the_three_states_apart() {
        let before = 1_775_326_472 - 3_600;
        assert_eq!(
            session_state([TOKEN_VALID], "https://x/start", "x", before),
            SsoSessionState::Valid {
                expires_at: Some("2026-04-04T18:14:32Z".to_string()),
                seconds_left: Some(3_600),
            }
        );
        assert!(matches!(
            session_state([TOKEN_VALID], "https://x/start", "x", 1_775_326_472 + 1),
            SsoSessionState::Expired { .. }
        ));
        // A cache holding only client registrations is "never signed in", not
        // "expired": the remedies are the same here, but the sentence shown
        // isn't, and "expired" for a session never used is simply wrong.
        let registration = r#"{"clientId":"a","clientSecret":"b"}"#;
        assert_eq!(
            session_state([registration], "https://x/start", "x", before),
            SsoSessionState::NeverLoggedIn
        );
    }

    /// A token with no readable expiry is usable, and saying otherwise would
    /// send someone re-authenticating for nothing.
    #[test]
    fn a_token_without_a_readable_expiry_still_counts_as_signed_in() {
        let odd = r#"{"accessToken":"t","sessionName":"x","expiresAt":"jamais"}"#;
        assert_eq!(
            session_state([odd], "https://x/start", "x", 0),
            SsoSessionState::Valid {
                expires_at: Some("jamais".to_string()),
                seconds_left: None,
            }
        );
        let none = r#"{"accessToken":"t","sessionName":"x"}"#;
        assert_eq!(
            session_state([none], "https://x/start", "x", 0),
            SsoSessionState::Valid { expires_at: None, seconds_left: None }
        );
    }

    /// `rename_all` on an internally-tagged enum renames the *variants*, never
    /// the fields of a struct variant — a silent mismatch this repo has been
    /// bitten by six times. Asserted on real JSON, since a Rust round trip
    /// proves nothing about the casing the frontend actually reads.
    #[test]
    fn the_json_state_carries_the_camel_cased_fields_the_frontend_reads() {
        let json = serde_json::to_value(SsoSessionState::Valid {
            expires_at: Some("2026-04-04T18:14:32Z".to_string()),
            seconds_left: Some(42),
        })
        .unwrap();
        assert_eq!(json["kind"], "valid");
        assert_eq!(json["secondsLeft"], 42);
        assert_eq!(json["expiresAt"], "2026-04-04T18:14:32Z");
        assert_eq!(serde_json::to_value(SsoSessionState::NeverLoggedIn).unwrap()["kind"], "neverLoggedIn");
        let expired = serde_json::to_value(SsoSessionState::Expired {
            expires_at: "2020-01-01T00:00:00Z".to_string(),
        })
        .unwrap();
        assert_eq!(expired["kind"], "expired");
        assert_eq!(expired["expiresAt"], "2020-01-01T00:00:00Z");
    }
}
