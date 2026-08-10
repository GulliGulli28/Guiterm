//! Signing in to Azure from inside the app.
//!
//! **Why this exists.** Without it, an expired Azure session is a dead end:
//! the import panel shows the CLI's own refusal and tells the user to go and
//! run `az login` in a terminal somewhere else. That is the same dead end the
//! AWS side removed when `aws_sso::login` was added, and this is deliberately
//! its mirror — spawn the CLI, stream what it prints while it waits, let the
//! panel show it.
//!
//! **Nothing is stored here either.** `az` writes its own token cache under
//! `~/.azure`, exactly as it does when run from a terminal, so the user's
//! other tools see the same session. This app never sees a credential, and
//! signing out is the CLI's `az logout`, not a file we delete.

use crate::cloud_cli::{self, CloudCliError, Provider};

/// Runs `az login`, reporting its output line by line as it arrives.
///
/// `tenant` pins the directory to authenticate against. Optional because the
/// common case — one tenant — needs no flag, and because the CLI's own error
/// message hands the right one over when it matters (see [`tenant_in_error`]).
///
/// `device_code` swaps the browser hand-off for a code the user types on
/// another device. Not the default: when a browser *can* open, opening it is
/// one step instead of three. It is offered because the browser flow simply
/// hangs where no browser can open — a remote session, a locked-down desktop —
/// and there would otherwise be no way through from inside the app.
pub async fn login(
    tenant: Option<&str>,
    device_code: bool,
    on_line: &mut (dyn FnMut(String) + Send),
) -> Result<(), CloudCliError> {
    let mut args = vec!["login"];
    if let Some(tenant) = tenant.map(str::trim).filter(|t| !t.is_empty()) {
        args.push("--tenant");
        args.push(tenant);
    }
    if device_code {
        args.push("--use-device-code");
    }
    // `az login` prints the full subscription list on success — pages of JSON
    // that say nothing to someone watching a sign-in. The interesting lines
    // are the URL and the code, both of which this keeps.
    args.push("--output");
    args.push("none");

    cloud_cli::run_streaming(Provider::Azure, &args, on_line).await
}

/// Runs `az logout`.
///
/// Offered next to signing in because switching accounts is the one case the
/// browser flow gets wrong on its own: `az login` reuses whoever is already
/// cached, so someone trying to reach a *different* tenant can otherwise
/// re-authenticate several times and keep landing on the same subscriptions.
///
/// A refusal is not an error worth raising: `az logout` fails when nobody was
/// signed in, which is exactly the state the caller wanted.
pub async fn logout() -> Result<(), CloudCliError> {
    match cloud_cli::run(Provider::Azure, &["logout"]).await {
        Err(missing @ CloudCliError::CliMissing { .. }) => Err(missing),
        // Anything else means the CLI ran and had nothing to sign out of.
        _ => Ok(()),
    }
}

/// The tenant id an Azure refusal names, when it names one.
///
/// The CLI's expired-session error ends with the exact command to run,
/// including `--tenant "…"`. Pulling it out means the sign-in form arrives
/// pre-filled with the right directory instead of asking the user to copy a
/// GUID out of an error message — which is the difference between a remedy and
/// a homework assignment.
///
/// Best effort by design: a miss leaves the field empty and the default tenant
/// is used, which is the correct behaviour for the single-tenant case anyway.
pub fn tenant_in_error(message: &str) -> Option<String> {
    let rest = message.split("--tenant").nth(1)?.trim_start();
    let value = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?,
        None => rest.split_whitespace().next()?,
    };
    let value = value.trim();
    // A tenant is a GUID or a domain; anything else is a parse that went
    // sideways and is better dropped than pre-filled wrongly.
    let plausible = !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    plausible.then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real message, captured from `az vm list` on 2026-08-10 against a
    /// session that had lapsed. The whole point is that the tenant is in
    /// there — the user should never have to fish it out by hand.
    const EXPIRED: &str = "ERROR: V2Error: invalid_grant AADSTS700082: The refresh token has \
        expired due to inactivity. The token was issued on 2026-04-20T14:30:28.0990908Z and was \
        inactive for 90.00:00:00. Trace ID: 20a49692-70c3-40ae-8130-bf9902091400 Correlation ID: \
        be3b62e3-cf49-42f2-93e6-2cd4529d3615 Timestamp: 2026-08-10 09:16:47Z. Status: \
        Response_Status.Status_InteractionRequired, Error code: 3399614467, Tag: 558133255\n\
        Run the command below to authenticate interactively; additional arguments may be added as \
        needed:\naz logout\naz login --tenant \"eeff6f72-412a-4df3-9eac-064920c95e17\" --scope \
        \"https://management.core.windows.net//.default\"";

    #[test]
    fn the_tenant_is_lifted_out_of_a_real_expired_session_error() {
        assert_eq!(
            tenant_in_error(EXPIRED).as_deref(),
            Some("eeff6f72-412a-4df3-9eac-064920c95e17")
        );
    }

    #[test]
    fn an_unquoted_tenant_is_read_too() {
        assert_eq!(
            tenant_in_error("az login --tenant contoso.onmicrosoft.com --scope x").as_deref(),
            Some("contoso.onmicrosoft.com")
        );
    }

    #[test]
    fn a_message_without_a_tenant_yields_nothing() {
        assert_eq!(tenant_in_error("ERROR: something else entirely"), None);
        assert_eq!(tenant_in_error(""), None);
    }

    /// Rather than pre-fill the form with a URL or a fragment of prose.
    #[test]
    fn an_implausible_capture_is_dropped() {
        assert_eq!(tenant_in_error("--tenant \"\""), None);
        assert_eq!(tenant_in_error("--tenant https://example.com/x?y=1"), None);
    }
}
