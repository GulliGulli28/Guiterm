//! SSH keypair generation (`ssh-keygen` equivalent) and public-key
//! deployment to a remote `authorized_keys` file (`ssh-copy-id` equivalent).
use crate::sftp::{self, SftpClient};
use getrandom::SysRng;
use getrandom::rand_core::UnwrapErr;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey, decode_secret_key};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAlgorithm {
    Ed25519,
    Rsa,
}

pub struct GeneratedKey {
    pub private_pem: String,
    pub public_line: String,
}

/// Generates a new keypair. `comment` becomes the trailing comment on the
/// public-key line (conventionally a name or email, as `ssh-keygen -C` does).
pub fn generate(
    algorithm: KeyAlgorithm,
    comment: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<GeneratedKey> {
    let algo = match algorithm {
        KeyAlgorithm::Ed25519 => Algorithm::Ed25519,
        KeyAlgorithm::Rsa => Algorithm::Rsa { hash: None },
    };
    let mut key = PrivateKey::random(&mut UnwrapErr(SysRng), algo)
        .map_err(|e| anyhow::anyhow!("génération de la clé impossible : {e}"))?;
    key.set_comment(comment);

    let public_line = key
        .public_key()
        .to_openssh()
        .map_err(|e| anyhow::anyhow!("encodage de la clé publique impossible : {e}"))?;

    let key = match passphrase {
        Some(pw) if !pw.is_empty() => key
            .encrypt(&mut SysRng, pw)
            .map_err(|e| anyhow::anyhow!("chiffrement de la clé impossible : {e}"))?,
        _ => key,
    };
    let private_pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| anyhow::anyhow!("encodage de la clé privée impossible : {e}"))?
        .to_string();

    Ok(GeneratedKey {
        private_pem,
        public_line,
    })
}

/// Derives the public-key line (`ssh-ed25519 AAAA... comment`) from a stored
/// private key's PEM content — used both to show it to the user and to
/// deploy it, without keeping the public half stored separately.
pub fn public_key_line(private_pem: &str, passphrase: Option<&str>) -> anyhow::Result<String> {
    let key = decode_secret_key(private_pem, passphrase)
        .map_err(|e| anyhow::anyhow!("clé privée invalide ou passphrase incorrecte : {e}"))?;
    key.public_key()
        .to_openssh()
        .map_err(|e| anyhow::anyhow!("encodage de la clé publique impossible : {e}"))
}

/// Ce que la page Clés montre d'une clé du trousseau sans la déchiffrer :
/// son type, son empreinte et sa ligne publique.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// « ed25519 », « RSA 4096 », « ECDSA »…
    pub algorithm: String,
    /// Empreinte SHA-256, au format d'OpenSSH (`SHA256:…`).
    pub fingerprint: String,
    /// La ligne `authorized_keys` (sans commentaire).
    pub public_key: String,
}

/// Décrit une clé privée (PEM ou OpenSSH). La partie publique d'une clé
/// OpenSSH se lit sans la passphrase ; un PEM chiffré en demande une. `None`
/// si la clé ne se lit pas — le fichier a disparu, ou la passphrase manque.
pub fn describe(private_key: &str, passphrase: Option<&str>) -> Option<KeyInfo> {
    use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};
    let public: PublicKey = crate::ssh_agent::keyring::public_key(private_key, passphrase)?;
    let algorithm = match public.algorithm() {
        Algorithm::Ed25519 => "ed25519".to_string(),
        Algorithm::Rsa { .. } => match public.key_data().rsa() {
            Some(rsa) => format!("RSA {}", rsa.key_size()),
            None => "RSA".to_string(),
        },
        Algorithm::Ecdsa { .. } => "ECDSA".to_string(),
        other => other.as_str().trim_start_matches("ssh-").to_string(),
    };
    Some(KeyInfo {
        algorithm,
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        public_key: public.to_openssh().ok()?,
    })
}

/// Computes the new `authorized_keys` content after adding `public_key_line`,
/// or `None` if the key (by key material, ignoring the comment) is already
/// present and the file doesn't need to change. Pure and I/O-free so the
/// dedup/append logic can be unit-tested without a real server — unlike the
/// other SFTP integration tests, there's no disposable, safely-namespaced
/// path to exercise this against: it's inherently about the one fixed,
/// security-sensitive `~/.ssh/authorized_keys` of whatever account runs the
/// test, which a test suite must never write to.
fn merge_authorized_keys(existing: &str, public_key_line: &str) -> Option<String> {
    // Compare by key material (the base64 blob) rather than the whole line,
    // so a key already present under a different comment isn't duplicated.
    let new_material = public_key_line.split_whitespace().nth(1)?;
    let already_present = existing
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(new_material));
    if already_present {
        return None;
    }

    let mut updated = existing.to_string();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(public_key_line.trim());
    updated.push('\n');
    Some(updated)
}

/// Deploys a public key to a remote host's `authorized_keys`
/// (`ssh-copy-id` equivalent): ensures `~/.ssh` exists and is `0700`,
/// appends the key if it isn't already present, and locks `authorized_keys`
/// down to `0600`. Idempotent — deploying the same key twice is a no-op the
/// second time.
pub async fn deploy_public_key(sftp: &SftpClient, public_key_line: &str) -> anyhow::Result<()> {
    let home = sftp.home_dir().await?;
    let ssh_dir = sftp::join(&home, ".ssh");
    if sftp.list(&ssh_dir).await.is_err() {
        sftp.make_dir(&ssh_dir).await?;
    }
    sftp.set_permissions(&ssh_dir, 0o700).await?;

    let authorized_keys = sftp::join(&ssh_dir, "authorized_keys");
    let existing = sftp
        .read_to_string(&authorized_keys)
        .await
        .unwrap_or_default();

    if let Some(updated) = merge_authorized_keys(&existing, public_key_line) {
        sftp.write_string(&authorized_keys, &updated).await?;
    }
    sftp.set_permissions(&authorized_keys, 0o600).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_roundtrips_without_passphrase() {
        let generated = generate(KeyAlgorithm::Ed25519, "test@example", None).expect("generate");
        assert!(generated.private_pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(generated.public_line.starts_with("ssh-ed25519 "));
        assert!(generated.public_line.ends_with("test@example"));

        let derived = public_key_line(&generated.private_pem, None).expect("derive public");
        assert_eq!(derived, generated.public_line);
    }

    #[test]
    fn rsa_roundtrips_with_passphrase() {
        let generated = generate(KeyAlgorithm::Rsa, "rsa-key", Some("hunter2")).expect("generate");
        assert!(generated.public_line.starts_with("ssh-rsa "));

        assert!(public_key_line(&generated.private_pem, None).is_err(), "wrong/missing passphrase must fail");
        assert!(public_key_line(&generated.private_pem, Some("wrong")).is_err());

        let derived = public_key_line(&generated.private_pem, Some("hunter2")).expect("derive public");
        assert_eq!(derived, generated.public_line);
    }

    #[test]
    fn describe_reads_an_encrypted_openssh_key_without_its_passphrase() {
        // C'est ce qui permet à la page Clés d'afficher type et empreinte
        // d'une clé protégée, sans rien demander.
        let generated = generate(KeyAlgorithm::Ed25519, "perso", Some("phrase")).expect("generate");
        let info = describe(&generated.private_pem, None).expect("décrite sans passphrase");
        assert_eq!(info.algorithm, "ed25519");
        assert!(info.fingerprint.starts_with("SHA256:"), "{}", info.fingerprint);
        assert!(generated.public_line.starts_with(&info.public_key), "{} / {}", info.public_key, generated.public_line);
    }

    #[test]
    fn describe_gives_the_rsa_size() {
        let generated = generate(KeyAlgorithm::Rsa, "rsa", None).expect("generate");
        let info = describe(&generated.private_pem, None).expect("décrite");
        assert!(info.algorithm.starts_with("RSA "), "{}", info.algorithm);
        assert!(info.algorithm.trim_start_matches("RSA ").parse::<usize>().unwrap() >= 2048, "{}", info.algorithm);
    }

    #[test]
    fn describe_refuses_garbage() {
        assert_eq!(describe("pas une clé", None), None);
    }

    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA1234 alice@laptop";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB5678 bob@desktop";

    #[test]
    fn merge_appends_to_empty_file() {
        let updated = merge_authorized_keys("", KEY_A).expect("should append");
        assert_eq!(updated, format!("{KEY_A}\n"));
    }

    #[test]
    fn merge_appends_after_existing_entries_missing_trailing_newline() {
        let existing = KEY_B.to_string(); // no trailing newline, as a hand-edited file might lack
        let updated = merge_authorized_keys(&existing, KEY_A).expect("should append");
        assert_eq!(updated, format!("{KEY_B}\n{KEY_A}\n"));
    }

    #[test]
    fn merge_is_idempotent_for_an_identical_line() {
        let existing = format!("{KEY_A}\n");
        assert_eq!(merge_authorized_keys(&existing, KEY_A), None);
    }

    #[test]
    fn merge_dedups_by_key_material_ignoring_a_different_comment() {
        let existing = format!("{KEY_A}\n");
        let same_key_new_comment = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA1234 renamed@elsewhere";
        assert_eq!(merge_authorized_keys(&existing, same_key_new_comment), None);
    }

    #[test]
    fn merge_keeps_unrelated_existing_keys_when_appending() {
        let existing = format!("{KEY_B}\n");
        let updated = merge_authorized_keys(&existing, KEY_A).expect("should append");
        assert_eq!(updated, format!("{KEY_B}\n{KEY_A}\n"));
    }
}
