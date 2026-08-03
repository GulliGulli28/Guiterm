//! Trying out a proxy command from the host form, before saving it.
//!
//! Its own module rather than a function in `hosts.rs`: this runs a program
//! and reports on it, where everything in `hosts.rs` reads or writes the
//! workspace. Nothing here touches persisted state.

use std::time::Duration;
use termius_core::proxy_command::{self, ProxyProbe};

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
