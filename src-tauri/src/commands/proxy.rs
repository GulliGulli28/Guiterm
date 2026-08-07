//! Trying out a proxy command from the host form, before saving it.
//!
//! Its own module rather than a function in `hosts.rs`: this runs a program
//! and reports on it, where everything in `hosts.rs` reads or writes the
//! workspace. Nothing here touches persisted state.

use std::time::Duration;
use termius_core::proxy_command::{self, ProxyProbe};
use termius_core::ssm_tunnel::{self, SsmProbe, SsmSpec};

/// How long to give the helper before calling it mute. Generous on purpose:
/// `aws ssm start-session` routinely takes several seconds to negotiate, and
/// a false "nothing came back" would send the user hunting for a problem that
/// isn't there.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Runs `command` the way a connection would, and reports whether it reaches
/// an SSH server. Authenticates nothing and keeps nothing open.
#[tauri::command]
pub async fn test_proxy_command(
    command: String,
    address: String,
    port: u16,
    username: String,
) -> Result<ProxyProbe, String> {
    if command.trim().is_empty() {
        return Err("La commande de proxy est vide".to_string());
    }
    Ok(proxy_command::probe(
        command.trim(),
        &address,
        port,
        &username,
        PROBE_TIMEOUT,
    )
    .await)
}

/// Opens an SSM port-forwarding tunnel to a database, tries one connection
/// through it, and tears it down — the "Tester" button of the SQL connection
/// form.
///
/// Worth its own command rather than reusing [`test_proxy_command`] because
/// the two answer different questions: that one proves a *byte stream* reached
/// an SSH server, this one proves a *port* was forwarded to something that
/// accepts TCP. Nothing is persisted and no credential is sent — see
/// [`termius_core::ssm_tunnel::probe`].
#[tauri::command]
pub async fn test_ssm_tunnel(
    target: String,
    profile: Option<String>,
    region: Option<String>,
    address: String,
    port: u16,
) -> Result<SsmProbe, String> {
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err("L'identifiant de l'instance SSM est vide (i-… ou mi-…)".to_string());
    }
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err("L'adresse de la base est vide — c'est elle que l'instance doit joindre".to_string());
    }
    Ok(ssm_tunnel::probe(SsmSpec {
        target,
        profile,
        region,
        remote_host: address,
        remote_port: port,
    })
    .await)
}
