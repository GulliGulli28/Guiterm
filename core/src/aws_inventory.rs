//! Discovering EC2 instances through the user's own `aws` CLI.
//!
//! **No AWS SDK, and no credentials of our own.** Every call shells out to the
//! CLI the user has already configured, which means SSO, `assume-role`, MFA
//! and credential-process all keep working exactly as they do in their
//! terminal, and this app never stores, reads or transmits a secret. It also
//! keeps a large dependency tree out of `core` — a lesson this repo learned
//! the hard way with `ironrdp` (see the sidecar's module docs).
//!
//! The cost of that choice is that the CLI must be installed and logged in.
//! That is a visible, actionable failure (see [`AwsCliError`]) rather than a
//! silent one, and the alternative — reimplementing the credential chain —
//! would fail in far less obvious ways.

use crate::proxy_command;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The proxy command written onto imported hosts.
///
/// `%h`/`%p` are left as tokens rather than resolved here: the user sees the
/// same form on an imported host as on one they wrote themselves, and can
/// still edit it. `--profile`/`--region` are baked in because they are what
/// the import was performed with — the app inherits no shell configuration, so
/// leaving them implicit would make an imported host work only for whoever's
/// default profile happens to match.
pub fn ssm_proxy_command(profile: &str, region: &str) -> String {
    format!(
        "aws ssm start-session --profile {profile} --region {region} --target %h \
         --document-name AWS-StartSSHSession --parameters portNumber=%p"
    )
}

/// Why a CLI call couldn't be made sense of. Kept apart from a plain string so
/// the UI can offer the matching remedy rather than printing a stack of AWS
/// jargon.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", rename_all_fields = "camelCase")]
pub enum AwsCliError {
    /// `aws` isn't installed, or isn't on this process's PATH.
    CliMissing,
    /// It ran and refused: expired SSO session, no credentials, denied.
    Refused {
        message: String,
        hint: Option<String>,
        /// The refusal is an expired login, so reconnecting the session fixes
        /// it. Typed rather than left for the UI to guess from the message:
        /// this is what decides whether a "reconnect" button appears, and
        /// matching on error text in the frontend would silently stop working
        /// the day AWS rewords one.
        session_expired: bool,
    },
    /// It answered something we couldn't read.
    Unreadable { message: String },
}

impl AwsCliError {
    pub fn message(&self) -> String {
        match self {
            Self::CliMissing => "La CLI `aws` est introuvable.".to_string(),
            Self::Refused { message, .. } | Self::Unreadable { message } => message.clone(),
        }
    }
}

/// One EC2 instance, as the import panel needs to show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsInstance {
    pub instance_id: String,
    /// The `Name` tag when there is one — that's what people actually call it.
    pub name: Option<String>,
    pub private_ip: Option<String>,
    pub public_ip: Option<String>,
    pub state: String,
    /// AMI platform hint, used to guess the login name.
    pub platform: Option<String>,
    /// Whether SSM can actually reach it. An instance that isn't registered
    /// can be imported, but the proxy command won't work until it is — so the
    /// panel shows it rather than hiding the instance.
    pub ssm_online: bool,
    /// Tag key/value pairs, offered as a grouping key at import time.
    pub tags: Vec<(String, String)>,
    /// Conventional login for this AMI family, from [`default_username_for`].
    ///
    /// A stored field rather than a method because the frontend needs it, and
    /// only fields are serialised — a method here would have been silently
    /// absent from the JSON, the exact shape of bug this repo has been bitten
    /// by before.
    pub default_username: String,
}

/// The conventional login name for an AMI family.
///
/// A guess, and presented as one in the UI: it is derived from the platform
/// string AWS reports, which is not a contract. Getting it right for the
/// common cases saves editing every imported host; getting it wrong costs one
/// field.
pub fn default_username_for(platform: Option<&str>) -> &'static str {
    let platform = platform.unwrap_or("").to_lowercase();
    if platform.contains("ubuntu") {
        "ubuntu"
    } else if platform.contains("rocky") {
        "rocky"
    } else if platform.contains("debian") {
        "admin"
    } else if platform.contains("centos") {
        "centos"
    } else if platform.contains("fedora") {
        "fedora"
    } else if platform.contains("suse") {
        "ec2-user"
    } else if platform.contains("windows") {
        "Administrator"
    } else {
        // Amazon Linux, and the safe default for anything unrecognised.
        "ec2-user"
    }
}

impl AwsInstance {
    /// What the panel shows as the host's label: the Name tag, else the id.
    pub fn label(&self) -> String {
        self.name.clone().unwrap_or_else(|| self.instance_id.clone())
    }
}

/// Turns a failed `aws` invocation into a typed error with a remedy.
///
/// Shares [`proxy_command::hint_for`] deliberately: the failures are the same
/// ones (expired SSO, missing credentials, denied), and having two tables drift
/// apart would mean the same problem is explained two different ways depending
/// on which button the user pressed.
pub fn classify_failure(stderr: &str) -> AwsCliError {
    let lowered = stderr.to_lowercase();
    if lowered.contains("is not recognized as an internal")
        || lowered.contains("n'est pas reconnu en tant que")
        || lowered.contains("command not found")
    {
        return AwsCliError::CliMissing;
    }
    AwsCliError::Refused {
        hint: proxy_command::hint_for(stderr),
        session_expired: is_expired_session(stderr),
        message: stderr.trim().to_string(),
    }
}

/// Whether a refusal is an expired login rather than a lasting problem.
///
/// Matched on the *idea* rather than on a list of exact sentences: AWS words
/// this at least four ways across the CLI, botocore and the service itself
/// (`ExpiredTokenException`, "Token has expired and refresh failed", "The SSO
/// session associated with this profile has expired", "security token included
/// in the request is expired"), and a list of phrases would fall out of date
/// silently — the button would just stop appearing.
///
/// Anything else (denied permissions, no credentials at all) is *not* fixed by
/// logging in again and must not offer to, which is why "expired" alone isn't
/// enough to qualify.
pub fn is_expired_session(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    lowered.contains("expired") && (lowered.contains("token") || lowered.contains("sso session"))
}

/// How long any single `aws` call may take. Generous: an SSO-backed call can
/// refresh a token on the way.
const CLI_TIMEOUT: Duration = Duration::from_secs(45);

/// Runs `aws` with the given arguments and returns its stdout.
pub(crate) async fn run_aws(args: &[&str]) -> Result<String, AwsCliError> {
    let mut command = tokio::process::Command::new("aws");
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // Same reasoning as `proxy_command::spawn`: no console window on Windows,
    // and never inherit a working directory that may not be usable.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match tokio::time::timeout(CLI_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AwsCliError::CliMissing);
        }
        Ok(Err(e)) => {
            return Err(AwsCliError::Unreadable {
                message: format!("`aws` n'a pas pu être exécutée : {e}"),
            });
        }
        Err(_) => {
            return Err(AwsCliError::Unreadable {
                message: "`aws` n'a pas répondu dans le temps imparti.".to_string(),
            });
        }
    };

    if !output.status.success() {
        return Err(classify_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A profile, with whatever `~/.aws/config` says about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsProfile {
    pub name: String,
    /// The `sso_session` this profile logs in through, when it has one.
    ///
    /// Worth surfacing because it is the unit of *login*: `aws sso login`
    /// authenticates a session, not a profile, so every profile sharing one
    /// becomes usable at once — and one expired session explains why a whole
    /// group of profiles stopped working.
    pub sso_session: Option<String>,
    pub account_id: Option<String>,
    pub role_name: Option<String>,
    /// The profile's own default region, used to prefill the region field.
    pub region: Option<String>,
}

/// An `[sso-session]` block: what a reconnection needs to replay.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsSsoSession {
    pub name: String,
    pub start_url: String,
    pub region: String,
}

/// The `[sso-session]` blocks defined in `~/.aws/config`.
///
/// Separate from [`parse_config`]'s profiles because they answer a different
/// question: a profile says *which* session it logs in through, and this says
/// *how* to log that session in again.
pub fn parse_sso_sessions(content: &str) -> Vec<AwsSsoSession> {
    let mut sessions: Vec<AwsSsoSession> = Vec::new();
    let mut current: Option<AwsSsoSession> = None;

    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if let Some(done) = current.take() {
                sessions.push(done);
            }
            if let Some(name) = header.trim().strip_prefix("sso-session ") {
                current = Some(AwsSsoSession {
                    name: name.trim().to_string(),
                    start_url: String::new(),
                    region: String::new(),
                });
            }
            continue;
        }
        let Some(session) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "sso_start_url" => session.start_url = value.trim().to_string(),
            "sso_region" => session.region = value.trim().to_string(),
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        sessions.push(done);
    }
    sessions
}

/// The sessions the CLI knows about, read from `~/.aws/config`.
pub fn list_sso_sessions() -> Vec<AwsSsoSession> {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".aws").join("config"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|content| parse_sso_sessions(&content))
        .unwrap_or_default()
}

/// Parses `~/.aws/config`.
///
/// Enough of the INI-ish grammar for the picker and no more: section headers
/// (`[default]`, `[profile x]`, `[sso-session y]`) and the handful of keys
/// that identify a profile. Nested sub-sections and every other setting are
/// skipped — this only ever *describes* profiles, the CLI remains the one
/// that uses them.
pub fn parse_config(content: &str) -> Vec<AwsProfile> {
    let mut profiles: Vec<AwsProfile> = Vec::new();
    let mut current: Option<AwsProfile> = None;

    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if let Some(done) = current.take() {
                profiles.push(done);
            }
            let header = header.trim();
            // `[sso-session x]` describes a login, not a profile: skipping it
            // keeps it from showing up in the picker as something selectable.
            let name = if let Some(rest) = header.strip_prefix("profile ") {
                rest.trim()
            } else if header == "default" {
                "default"
            } else {
                continue;
            };
            current = Some(AwsProfile {
                name: name.to_string(),
                sso_session: None,
                account_id: None,
                role_name: None,
                region: None,
            });
            continue;
        }
        let Some(profile) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "sso_session" => profile.sso_session = Some(value),
            "sso_account_id" => profile.account_id = Some(value),
            "sso_role_name" => profile.role_name = Some(value),
            "region" => profile.region = Some(value),
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        profiles.push(done);
    }
    profiles
}

/// Profiles available to the CLI, described from `~/.aws/config`.
///
/// The CLI decides which profiles *exist* — it also reads `~/.aws/credentials`,
/// which this parser deliberately ignores — and the config file only fills in
/// the details. A profile the CLI knows and the file doesn't still shows up,
/// just without an SSO session.
pub async fn list_profiles() -> Result<Vec<AwsProfile>, AwsCliError> {
    let out = run_aws(&["configure", "list-profiles"]).await?;
    let described = directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".aws").join("config"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|content| parse_config(&content))
        .unwrap_or_default();

    Ok(out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|name| {
            described
                .iter()
                .find(|profile| profile.name == name)
                .cloned()
                .unwrap_or_else(|| AwsProfile {
                    name: name.to_string(),
                    sso_session: None,
                    account_id: None,
                    role_name: None,
                    region: None,
                })
        })
        .collect())
}

/// Who a profile actually turns out to be, as `sts get-caller-identity` says.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub account: String,
    /// The full ARN — the only part that names the *role*, which is what
    /// distinguishes two profiles on the same account.
    pub arn: String,
    pub user_id: String,
}

pub fn parse_caller_identity(json: &str) -> Result<CallerIdentity, AwsCliError> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
            message: format!("réponse get-caller-identity illisible : {e}"),
        })?;
    Ok(CallerIdentity {
        account: parsed["Account"].as_str().unwrap_or_default().to_string(),
        arn: parsed["Arn"].as_str().unwrap_or_default().to_string(),
        user_id: parsed["UserId"].as_str().unwrap_or_default().to_string(),
    })
}

/// Resolves a profile to the identity AWS grants it right now.
///
/// The one call that answers "does this profile still work", and the cheapest
/// one there is — no permissions are needed beyond being authenticated, so a
/// failure here means the credentials, not the rights. Which is exactly what
/// makes it usable as a check button next to every profile.
pub async fn whoami(profile: &str) -> Result<CallerIdentity, AwsCliError> {
    let out = run_aws(&[
        "sts",
        "get-caller-identity",
        "--profile",
        profile,
        "--output",
        "json",
    ])
    .await?;
    parse_caller_identity(&out)
}

/// Instance ids SSM currently reports as online.
async fn ssm_online_ids(profile: &str, region: &str) -> Result<Vec<String>, AwsCliError> {
    let out = run_aws(&[
        "ssm",
        "describe-instance-information",
        "--profile",
        profile,
        "--region",
        region,
        "--output",
        "json",
    ])
    .await?;
    let parsed: serde_json::Value = serde_json::from_str(&out).map_err(|e| AwsCliError::Unreadable {
        message: format!("réponse SSM illisible : {e}"),
    })?;
    Ok(parsed["InstanceInformationList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|entry| entry["PingStatus"].as_str() == Some("Online"))
                .filter_map(|entry| entry["InstanceId"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// Parses `aws ec2 describe-instances --output json`.
///
/// Split out from the call so the shape-handling is testable against captured
/// payloads without an AWS account — which is the only way it can be tested at
/// all from a development machine.
pub fn parse_instances(json: &str, ssm_online: &[String]) -> Result<Vec<AwsInstance>, AwsCliError> {
    let parsed: serde_json::Value = serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
        message: format!("réponse EC2 illisible : {e}"),
    })?;
    let mut instances = Vec::new();
    let Some(reservations) = parsed["Reservations"].as_array() else {
        return Ok(instances);
    };
    for reservation in reservations {
        let Some(list) = reservation["Instances"].as_array() else {
            continue;
        };
        for raw in list {
            let Some(instance_id) = raw["InstanceId"].as_str() else {
                continue;
            };
            let tags: Vec<(String, String)> = raw["Tags"]
                .as_array()
                .map(|tags| {
                    tags.iter()
                        .filter_map(|tag| {
                            Some((tag["Key"].as_str()?.to_string(), tag["Value"].as_str()?.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let name = tags
                .iter()
                .find(|(key, _)| key == "Name")
                .map(|(_, value)| value.clone())
                .filter(|value| !value.is_empty());
            // `PlatformDetails` is the descriptive one ("Linux/UNIX", "Red Hat
            // Enterprise Linux"...); `Platform` is only ever set for Windows.
            let platform = raw["PlatformDetails"]
                .as_str()
                .or_else(|| raw["Platform"].as_str())
                .map(str::to_string);
            instances.push(AwsInstance {
                default_username: default_username_for(platform.as_deref()).to_string(),
                ssm_online: ssm_online.iter().any(|id| id == instance_id),
                instance_id: instance_id.to_string(),
                name,
                private_ip: raw["PrivateIpAddress"].as_str().map(str::to_string),
                public_ip: raw["PublicIpAddress"].as_str().map(str::to_string),
                state: raw["State"]["Name"].as_str().unwrap_or("unknown").to_string(),
                platform,
                tags,
            });
        }
    }
    // Newest-first is meaningless here; a stable, readable order is not.
    instances.sort_by_key(|instance| instance.label().to_lowercase());
    Ok(instances)
}

/// Lists the EC2 instances visible to `profile` in `region`, annotated with
/// whether SSM can reach each one.
///
/// Terminated instances are dropped — they can't be connected to and would
/// only pad the list. Everything else is kept, including instances SSM doesn't
/// know about: seeing one listed as unreachable is more useful than wondering
/// why it's missing.
pub async fn discover(profile: &str, region: &str) -> Result<Vec<AwsInstance>, AwsCliError> {
    // Not fatal: without SSM information every instance simply shows as
    // unregistered, which is still a usable listing.
    let online = ssm_online_ids(profile, region).await.unwrap_or_default();
    let json = run_aws(&[
        "ec2",
        "describe-instances",
        "--profile",
        profile,
        "--region",
        region,
        "--output",
        "json",
    ])
    .await?;
    let mut instances = parse_instances(&json, &online)?;
    instances.retain(|instance| instance.state != "terminated");
    Ok(instances)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `describe-instances` payload.
    const PAYLOAD: &str = r#"{
      "Reservations": [
        {
          "Instances": [
            {
              "InstanceId": "i-0df4dfebfd9fe0362",
              "PrivateIpAddress": "172.16.15.12",
              "State": { "Name": "running" },
              "PlatformDetails": "Red Hat Enterprise Linux",
              "Tags": [
                { "Key": "Name", "Value": "rocky-app-01" },
                { "Key": "Environment", "Value": "prod" }
              ]
            },
            {
              "InstanceId": "i-0aaaaaaaaaaaaaaaa",
              "PublicIpAddress": "1.2.3.4",
              "State": { "Name": "terminated" },
              "Tags": []
            }
          ]
        },
        {
          "Instances": [
            {
              "InstanceId": "i-0978d0081ce557b57",
              "PrivateIpAddress": "172.16.20.7",
              "State": { "Name": "running" },
              "PlatformDetails": "Ubuntu",
              "Tags": [{ "Key": "Name", "Value": "app-db-01" }]
            }
          ]
        }
      ]
    }"#;

    // Instances are spread across reservations, which is an AWS grouping with
    // no meaning here — flattening it wrong silently loses machines.
    #[test]
    fn flattens_instances_across_reservations() {
        let parsed = parse_instances(PAYLOAD, &[]).unwrap();
        assert_eq!(parsed.len(), 3, "les trois instances doivent être vues");
        assert!(parsed.iter().any(|i| i.instance_id == "i-0978d0081ce557b57"));
    }

    #[test]
    fn reads_the_name_tag_and_falls_back_to_the_id() {
        let parsed = parse_instances(PAYLOAD, &[]).unwrap();
        let named = parsed.iter().find(|i| i.instance_id == "i-0df4dfebfd9fe0362").unwrap();
        assert_eq!(named.label(), "rocky-app-01");
        let untagged = parsed.iter().find(|i| i.instance_id == "i-0aaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(untagged.label(), "i-0aaaaaaaaaaaaaaaa");
    }

    #[test]
    fn marks_only_the_instances_ssm_reports_online() {
        let online = vec!["i-0df4dfebfd9fe0362".to_string()];
        let parsed = parse_instances(PAYLOAD, &online).unwrap();
        assert!(parsed.iter().find(|i| i.instance_id == "i-0df4dfebfd9fe0362").unwrap().ssm_online);
        assert!(!parsed.iter().find(|i| i.instance_id == "i-0978d0081ce557b57").unwrap().ssm_online);
    }

    #[test]
    fn guesses_the_login_name_from_the_platform() {
        let parsed = parse_instances(PAYLOAD, &[]).unwrap();
        let ubuntu = parsed.iter().find(|i| i.instance_id == "i-0978d0081ce557b57").unwrap();
        assert_eq!(ubuntu.default_username, "ubuntu");
        // Unrecognised platforms must land on Amazon Linux's login rather than
        // on nothing.
        let untagged = parsed.iter().find(|i| i.instance_id == "i-0aaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(untagged.default_username, "ec2-user");
        assert_eq!(default_username_for(Some("Rocky Linux 8")), "rocky");
    }

    #[test]
    fn keeps_tags_for_grouping() {
        let parsed = parse_instances(PAYLOAD, &[]).unwrap();
        let named = parsed.iter().find(|i| i.instance_id == "i-0df4dfebfd9fe0362").unwrap();
        assert!(named.tags.iter().any(|(k, v)| k == "Environment" && v == "prod"));
    }

    // An account with nothing in it is not an error.
    #[test]
    fn an_empty_account_is_an_empty_list() {
        assert!(parse_instances(r#"{"Reservations": []}"#, &[]).unwrap().is_empty());
    }

    #[test]
    fn a_missing_cli_is_told_apart_from_a_refusal() {
        assert_eq!(
            classify_failure("'aws' is not recognized as an internal or external command"),
            AwsCliError::CliMissing
        );
        assert_eq!(classify_failure("aws: command not found"), AwsCliError::CliMissing);
        match classify_failure("An error occurred (ExpiredTokenException) when calling ...") {
            AwsCliError::Refused { hint, session_expired, .. } => {
                assert!(hint.expect("un token expiré a une remédiation").contains("sso login"));
                assert!(session_expired, "une session expirée doit être reconnaissable comme telle");
            }
            other => panic!("attendu un refus, obtenu {other:?}"),
        }
    }

    /// Only an expired login may offer to reconnect. Denied permissions and
    /// missing credentials are not fixed by logging in again, and proposing it
    /// would send someone round a loop that cannot work.
    #[test]
    fn only_an_expired_session_is_flagged_as_reconnectable() {
        assert!(is_expired_session("An error occurred (ExpiredTokenException)"));
        assert!(is_expired_session("Error loading SSO Token: Token has expired and refresh failed"), "message alternatif");
        assert!(!is_expired_session("An error occurred (AccessDenied) when calling DescribeInstances"));
        assert!(!is_expired_session("Unable to locate credentials"));
        // Says "expired" and is not a login problem at all: the machine's
        // clock has drifted, and signing in again fixes nothing. This is the
        // case that makes the word alone insufficient.
        assert!(!is_expired_session(
            "An error occurred (RequestExpired) when calling DescribeInstances: Request has expired."
        ));
    }

    #[test]
    fn reads_the_sso_session_blocks() {
        let sessions = parse_sso_sessions(CONFIG);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "ma-boite");
        assert_eq!(sessions[0].start_url, "https://ma-boite.awsapps.com/start");
        assert_eq!(sessions[0].region, "eu-west-3");
    }

    /// The frontend reads `defaultUsername` off the JSON; a method would have
    /// serialised to nothing at all and left every imported host with an empty
    /// login. Asserted on real JSON rather than a Rust round trip, which would
    /// prove nothing about the casing or the field even being there.
    #[test]
    fn the_json_carries_the_camel_cased_fields_the_frontend_reads() {
        let parsed = parse_instances(PAYLOAD, &["i-0978d0081ce557b57".to_string()]).unwrap();
        let ubuntu = parsed.iter().find(|i| i.instance_id == "i-0978d0081ce557b57").unwrap();
        let json = serde_json::to_value(ubuntu).unwrap();
        assert_eq!(json["defaultUsername"], "ubuntu");
        assert_eq!(json["instanceId"], "i-0978d0081ce557b57");
        assert_eq!(json["ssmOnline"], true);
        assert_eq!(json["privateIp"], "172.16.20.7");
    }

    const CONFIG: &str = "\
[default]\n\
region = us-east-1\n\
\n\
[sso-session ma-boite]\n\
sso_start_url = https://ma-boite.awsapps.com/start\n\
sso_region = eu-west-3\n\
\n\
[profile AdministratorAccess-167004607868]\n\
sso_session = ma-boite\n\
sso_account_id = 167004607868\n\
sso_role_name = AdministratorAccess\n\
region = eu-west-3\n\
output = json\n\
\n\
[profile ReadOnly-999999999999]\n\
sso_session = ma-boite\n\
sso_account_id = 999999999999\n\
sso_role_name = ReadOnly\n\
";

    #[test]
    fn reads_profiles_and_their_sso_session() {
        let profiles = parse_config(CONFIG);
        let admin = profiles.iter().find(|p| p.name == "AdministratorAccess-167004607868").unwrap();
        assert_eq!(admin.sso_session.as_deref(), Some("ma-boite"));
        assert_eq!(admin.account_id.as_deref(), Some("167004607868"));
        assert_eq!(admin.role_name.as_deref(), Some("AdministratorAccess"));
        assert_eq!(admin.region.as_deref(), Some("eu-west-3"));
    }

    // `[sso-session x]` is a login, not something connectable. Listing it as a
    // profile would offer the user a choice that cannot work.
    #[test]
    fn an_sso_session_block_is_not_a_profile() {
        let names: Vec<_> = parse_config(CONFIG).into_iter().map(|p| p.name).collect();
        assert!(!names.iter().any(|n| n == "ma-boite"), "obtenu : {names:?}");
        assert_eq!(names, vec!["default", "AdministratorAccess-167004607868", "ReadOnly-999999999999"]);
    }

    #[test]
    fn the_default_profile_is_named_default_not_profile_default() {
        let profiles = parse_config(CONFIG);
        let first = &profiles[0];
        assert_eq!(first.name, "default");
        assert_eq!(first.region.as_deref(), Some("us-east-1"));
        assert_eq!(first.sso_session, None);
    }

    #[test]
    fn a_profile_without_a_region_reports_none_rather_than_an_empty_string() {
        let profiles = parse_config("[profile bare]\nregion =\n");
        assert_eq!(profiles[0].region, None);
    }

    #[test]
    fn reads_the_caller_identity() {
        let json = r#"{
          "UserId": "AROAX:guillaume",
          "Account": "167004607868",
          "Arn": "arn:aws:sts::167004607868:assumed-role/AWSReservedSSO_AdministratorAccess_abc/guillaume"
        }"#;
        let identity = parse_caller_identity(json).unwrap();
        assert_eq!(identity.account, "167004607868");
        assert!(identity.arn.contains("AdministratorAccess"));
        assert_eq!(identity.user_id, "AROAX:guillaume");
        // Read off the JSON by the frontend, so the casing is part of the
        // contract rather than an implementation detail.
        let value = serde_json::to_value(&identity).unwrap();
        assert_eq!(value["userId"], "AROAX:guillaume");
    }

    // The profile and region are baked in on purpose: the app inherits no
    // shell configuration, so an imported host that relied on the default
    // profile would work only by luck.
    #[test]
    fn the_generated_command_pins_the_profile_and_region() {
        let command = ssm_proxy_command("AdministratorAccess-1670", "eu-west-3");
        assert!(command.contains("--profile AdministratorAccess-1670"));
        assert!(command.contains("--region eu-west-3"));
        assert!(command.contains("--target %h"), "les jetons doivent rester des jetons");
        assert!(command.contains("portNumber=%p"));
    }
}
