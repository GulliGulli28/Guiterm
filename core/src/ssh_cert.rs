//! OpenSSH user certificates: locating one, reading it, and saying why the
//! server is about to refuse it.
//!
//! **Why this module exists at all.** A server that trusts a CA
//! (`TrustedUserCAKeys`) refuses every bad certificate the same way: `Permission
//! denied (publickey)`. Expired an hour ago, signed for a principal this account
//! doesn't grant, signed by a CA this server doesn't trust — one message for
//! three unrelated problems, and the one that actually happens ten times a day
//! (expiry, because certificates are deliberately short-lived) is the one the
//! message helps with least.
//!
//! So the checks that can be made locally are made locally, *before* the
//! attempt, and reported in their own words. The same reasoning as
//! [`crate::proxy_command`]'s remediation hints for expired SSO sessions: the
//! server's own error is technically correct and practically useless.
//!
//! What can't be checked here is left to the server and said as such — whether
//! the CA is trusted, and whether the principals match, are facts only the
//! server holds.

use russh::keys::ssh_key::Certificate;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The certificate OpenSSH would look for next to `key_path`.
///
/// `ssh-keygen -s` writes `<key>-cert.pub` beside the key it signs, and OpenSSH
/// loads it from there without being told. Following the same convention means
/// the field is usually already filled in correctly.
///
/// Note this appends to the *private* key's name (`id_ed25519` →
/// `id_ed25519-cert.pub`), which is what `ssh-keygen` does — not a replacement
/// of a `.pub` extension.
pub fn conventional_cert_path(key_path: &str) -> Option<PathBuf> {
    let trimmed = key_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed.strip_suffix(".pub").unwrap_or(trimmed);
    Some(PathBuf::from(format!("{stripped}-cert.pub")))
}

/// [`conventional_cert_path`], but only when that file is actually there.
///
/// What the host form offers as a prefill: proposing a path to a file that
/// doesn't exist would look like the app found something when it didn't.
pub fn existing_conventional_cert_path(key_path: &str) -> Option<PathBuf> {
    conventional_cert_path(key_path).filter(|path| path.is_file())
}

/// Why a certificate can't be used, in words that name the remedy.
#[derive(Debug, Clone, PartialEq)]
pub enum CertProblem {
    /// The file isn't there. Ordinary rather than exceptional: certificates
    /// expire and get replaced, and a refresh that failed leaves nothing
    /// behind.
    Missing { path: String },
    /// There, but not an OpenSSH certificate — pointing at the public key
    /// (`id_ed25519.pub`) instead of the certificate (`id_ed25519-cert.pub`)
    /// is the mistake this catches, and the two names differ by one word.
    Unreadable { path: String, reason: String },
    /// Valid once, not any more. The common case by far.
    Expired { key_id: String, since_secs: u64 },
    /// Not valid *yet* — a clock skew between this machine and whatever signed
    /// it, almost always. Worth telling apart from expiry: the remedy is to fix
    /// the clock, not to renew anything.
    NotYetValid { key_id: String, in_secs: u64 },
}

impl CertProblem {
    /// The message shown to the user, remedy included.
    pub fn message(&self) -> String {
        match self {
            Self::Missing { path } => format!(
                "Certificat introuvable : {path}\n\
                 Le fichier a peut-être été remplacé ou n'a jamais été écrit — \
                 regénérer le certificat auprès de la CA."
            ),
            Self::Unreadable { path, reason } => format!(
                "Certificat illisible : {path}\n\
                 {reason}\n\
                 Attendu un certificat OpenSSH (« …-cert.pub », signé par une CA), \
                 pas une clé publique ordinaire (« ….pub »)."
            ),
            Self::Expired { key_id, since_secs } => format!(
                "Certificat expiré depuis {} ({key_id}).\n\
                 C'est le fonctionnement normal d'une CA : les certificats sont courts. \
                 En obtenir un neuf, puis réessayer.",
                humanise(*since_secs)
            ),
            Self::NotYetValid { key_id, in_secs } => format!(
                "Certificat pas encore valide (il le devient dans {}, {key_id}).\n\
                 L'horloge de cette machine est probablement décalée par rapport à celle \
                 qui a signé le certificat — c'est l'horloge qu'il faut corriger, pas le certificat.",
                humanise(*in_secs)
            ),
        }
    }
}

/// A duration in the coarsest unit that still says something useful.
///
/// Certificate lifetimes are measured in hours; seconds would be noise, and
/// "expired 0 hours ago" reads as a bug.
fn humanise(seconds: u64) -> String {
    if seconds < 60 {
        return "moins d'une minute".to_string();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let hours = minutes / 60;
    if hours < 24 {
        let rest = minutes % 60;
        return if rest > 0 { format!("{hours} h {rest} min") } else { format!("{hours} h") };
    }
    let days = hours / 24;
    let rest = hours % 24;
    if rest > 0 { format!("{days} j {rest} h") } else { format!("{days} j") }
}

/// Whether `cert` is usable at `now` (seconds since the Unix epoch).
///
/// Only the validity window, because it is the only half of "will the server
/// take this" that can be answered without the server. Principals and CA trust
/// are the server's to judge — guessing at them here would produce confident
/// wrong answers.
///
/// `now` is a parameter rather than read here so both branches are testable
/// without waiting for a certificate to expire.
pub fn validity_problem(cert: &Certificate, now: u64) -> Option<CertProblem> {
    let key_id = describe(cert);
    if cert.valid_before() <= now {
        return Some(CertProblem::Expired {
            key_id,
            since_secs: now - cert.valid_before(),
        });
    }
    if cert.valid_after() > now {
        return Some(CertProblem::NotYetValid {
            key_id,
            in_secs: cert.valid_after() - now,
        });
    }
    None
}

/// How a certificate names itself, for a message the user can act on.
///
/// `ssh-keygen -s -I <id>` puts that identity in the certificate, and it is
/// usually the login or the machine it was issued for — far more recognisable
/// than a fingerprint. Falls back to the serial when it's empty, which some
/// issuers leave blank.
fn describe(cert: &Certificate) -> String {
    let id = cert.key_id().trim();
    if id.is_empty() {
        format!("série {}", cert.serial())
    } else {
        id.to_string()
    }
}

/// Reads the certificate at `path` and checks what can be checked locally.
///
/// Returns the parsed certificate on success — the caller needs it to
/// authenticate, and re-reading would open a window where the file changed
/// between the check and the use.
pub fn load(path: &Path) -> Result<Certificate, CertProblem> {
    let display = path.display().to_string();
    let text = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CertProblem::Missing { path: display.clone() }
        } else {
            CertProblem::Unreadable { path: display.clone(), reason: e.to_string() }
        }
    })?;
    let cert = Certificate::from_openssh(text.trim())
        .map_err(|e| CertProblem::Unreadable { path: display, reason: e.to_string() })?;
    match validity_problem(&cert, now_secs()) {
        Some(problem) => Err(problem),
        None => Ok(cert),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_conventional_path_is_the_key_name_plus_cert_pub() {
        assert_eq!(
            conventional_cert_path("/home/glorin/.ssh/id_ed25519").unwrap(),
            PathBuf::from("/home/glorin/.ssh/id_ed25519-cert.pub")
        );
    }

    /// Pointed at the *public* key by mistake — a plausible slip, since the
    /// picker browses for files and the two sit side by side. `ssh-keygen`
    /// names the certificate after the private key either way.
    #[test]
    fn a_pub_suffix_is_not_doubled_up() {
        assert_eq!(
            conventional_cert_path("~/.ssh/id_rsa.pub").unwrap(),
            PathBuf::from("~/.ssh/id_rsa-cert.pub")
        );
    }

    #[test]
    fn no_key_means_no_suggestion() {
        assert_eq!(conventional_cert_path(""), None);
        assert_eq!(conventional_cert_path("   "), None);
    }

    /// The message is the entire point of this module — a bare "Permission
    /// denied" is what it exists to replace, so each problem has to name its
    /// own remedy rather than share a generic one.
    #[test]
    fn each_problem_says_what_to_do_about_it() {
        let expired = CertProblem::Expired { key_id: "glorin".into(), since_secs: 7200 }.message();
        assert!(expired.contains("2 h"), "la durée doit être lisible : {expired}");
        assert!(expired.contains("neuf"), "doit dire d'en obtenir un neuf : {expired}");

        // Clock skew, not expiry: renewing the certificate would fix nothing.
        let early = CertProblem::NotYetValid { key_id: "glorin".into(), in_secs: 300 }.message();
        assert!(early.contains("horloge"), "doit pointer l'horloge : {early}");
        assert!(!early.contains("expiré"));

        let unreadable = CertProblem::Unreadable {
            path: "/k.pub".into(),
            reason: "unsupported".into(),
        }
        .message();
        assert!(unreadable.contains("-cert.pub"), "doit distinguer .pub de -cert.pub : {unreadable}");
    }

    #[test]
    fn durations_read_in_the_coarsest_useful_unit() {
        assert_eq!(humanise(30), "moins d'une minute");
        assert_eq!(humanise(42 * 60), "42 min");
        assert_eq!(humanise(2 * 3600), "2 h");
        assert_eq!(humanise(2 * 3600 + 15 * 60), "2 h 15 min");
        assert_eq!(humanise(50 * 3600), "2 j 2 h");
    }

    #[test]
    fn a_missing_file_is_reported_as_missing_not_as_unreadable() {
        let problem = load(Path::new("/nowhere/at/all-cert.pub")).unwrap_err();
        assert!(matches!(problem, CertProblem::Missing { .. }), "{problem:?}");
    }

    /// The mistake this catches: pointing the field at the public key instead
    /// of the certificate. Both are one line of base64 starting with `ssh-`,
    /// so nothing about the file's look gives it away.
    #[test]
    fn a_public_key_is_refused_as_not_being_a_certificate() {
        let dir = std::env::temp_dir().join(format!("guiterm-cert-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_ed25519.pub");
        std::fs::write(
            &path,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4qkPWJ3xQK8VJ9K1lF9Zn0hQ4vJ0j9c8Bx4YQ2h5vN glorin\n",
        )
        .unwrap();

        let problem = load(&path).unwrap_err();
        assert!(matches!(problem, CertProblem::Unreadable { .. }), "{problem:?}");
        assert!(problem.message().contains("-cert.pub"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
