//! Ce qu'on demande à l'agent de signer — pour le dire à l'utilisateur avant
//! qu'il accepte. Deux formes se reconnaissent sans ambiguïté :
//!
//! - une **connexion SSH** (RFC 4252 §7) : l'id de session, puis
//!   `SSH_MSG_USERAUTH_REQUEST`, l'utilisateur, le service, la méthode
//!   `publickey` (ou sa variante liée à l'hôte, qui porte la clé d'hôte) ;
//! - une **signature SSHSIG** (`ssh-keygen -Y sign`, PROTOCOL.sshsig) : le
//!   préambule `SSHSIG`, puis l'espace de noms — `git` pour un commit ou une
//!   étiquette signés, `file` pour un fichier.
//!
//! Le reste est « autre chose » : signé seulement si l'utilisateur accepte
//! en connaissance de cause.
use super::protocol::Reader;

const USERAUTH_REQUEST: u8 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Purpose {
    SshLogin {
        session_id: Vec<u8>,
        user: String,
        /// La clé d'hôte, quand le client l'y a mise (méthode
        /// `publickey-hostbound-v00@openssh.com`).
        host_key: Option<Vec<u8>>,
    },
    Sshsig {
        namespace: String,
    },
    Unknown,
}

pub fn describe(data: &[u8]) -> Purpose {
    if let Some(rest) = data.strip_prefix(b"SSHSIG") {
        let mut r = Reader::new(rest);
        if let Some(namespace) = r.string() {
            return Purpose::Sshsig { namespace };
        }
        return Purpose::Unknown;
    }
    let mut r = Reader::new(data);
    let parsed = (|| {
        let session_id = r.bytes()?.to_vec();
        if r.u8()? != USERAUTH_REQUEST {
            return None;
        }
        let user = r.string()?;
        let _service = r.string()?;
        let method = r.string()?;
        if !method.starts_with("publickey") || !r.bool()? {
            return None;
        }
        let _alg = r.string()?;
        let _key = r.bytes()?;
        let host_key = if method == "publickey-hostbound-v00@openssh.com" {
            Some(r.bytes()?.to_vec())
        } else {
            None
        };
        Some(Purpose::SshLogin { session_id, user, host_key })
    })();
    parsed.unwrap_or(Purpose::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(b: &[u8]) -> Vec<u8> {
        let mut v = (b.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(b);
        v
    }

    #[test]
    fn recognises_a_git_signature() {
        let data = [b"SSHSIG".to_vec(), string(b"git"), string(b""), string(b"sha512"), string(&[0; 64])].concat();
        assert_eq!(describe(&data), Purpose::Sshsig { namespace: "git".into() });
    }

    #[test]
    fn recognises_an_ssh_login_with_or_without_host_key() {
        let base = |method: &[u8]| {
            [string(b"SESSION"), vec![USERAUTH_REQUEST], string(b"deploy"), string(b"ssh-connection"), string(method), vec![1], string(b"ssh-ed25519"), string(b"KEY")].concat()
        };
        assert_eq!(
            describe(&base(b"publickey")),
            Purpose::SshLogin { session_id: b"SESSION".to_vec(), user: "deploy".into(), host_key: None }
        );
        let bound = [base(b"publickey-hostbound-v00@openssh.com"), string(b"HOSTKEY")].concat();
        assert_eq!(
            describe(&bound),
            Purpose::SshLogin { session_id: b"SESSION".to_vec(), user: "deploy".into(), host_key: Some(b"HOSTKEY".to_vec()) }
        );
    }

    #[test]
    fn anything_else_is_unknown() {
        assert_eq!(describe(b"quelque chose"), Purpose::Unknown);
        assert_eq!(describe(b"SSHSIG"), Purpose::Unknown);
        // Une vraie trame d'authentification, mais pas par clé publique.
        let pw = [string(b"S"), vec![USERAUTH_REQUEST], string(b"u"), string(b"ssh-connection"), string(b"password"), vec![0]].concat();
        assert_eq!(describe(&pw), Purpose::Unknown);
    }
}
