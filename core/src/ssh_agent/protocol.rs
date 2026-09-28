//! Le format des messages de l'agent SSH (draft-miller-ssh-agent) : une trame
//! = `u32` de longueur, puis un octet de type et son contenu. Seul ce dont un
//! agent adossé au coffre a besoin est compris — lister les clés, signer,
//! l'extension `session-bind@openssh.com` — ; tout le reste (ajouter,
//! retirer, verrouiller des clés) reçoit un refus : les clés viennent du
//! trousseau de Guiterm, pas des clients.

/// Au-delà, la trame est refusée : aucune demande légitime n'en approche
/// (une signature de commit porte un condensé, pas le commit).
pub const MAX_FRAME: usize = 256 * 1024;

pub const FAILURE: u8 = 5;
pub const SUCCESS: u8 = 6;
pub const REQUEST_IDENTITIES: u8 = 11;
pub const IDENTITIES_ANSWER: u8 = 12;
pub const SIGN_REQUEST: u8 = 13;
pub const SIGN_RESPONSE: u8 = 14;
pub const EXTENSION: u8 = 27;
pub const EXTENSION_FAILURE: u8 = 28;

/// Drapeaux d'une demande de signature RSA : l'algorithme de hachage voulu.
pub const RSA_SHA2_256: u32 = 2;
pub const RSA_SHA2_512: u32 = 4;

/// Une demande d'un client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Identities,
    Sign {
        key_blob: Vec<u8>,
        data: Vec<u8>,
        flags: u32,
    },
    /// Le client dit à quel serveur il est connecté : la clé d'hôte, l'id de
    /// session (le condensé de l'échange de clés), la signature de l'hôte sur
    /// cet id, et si c'est une connexion relayée (agent transféré).
    SessionBind {
        host_key: Vec<u8>,
        session_id: Vec<u8>,
        signature: Vec<u8>,
        forwarding: bool,
    },
    /// Une extension qu'on ne connaît pas.
    UnknownExtension(String),
    /// Tout autre type de message (ajout, retrait, verrou…).
    Other(u8),
}

/// Lecture des types SSH (RFC 4251 §5) dans un tampon.
pub struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    pub fn u8(&mut self) -> Option<u8> {
        let (&b, rest) = self.buf.split_first()?;
        self.buf = rest;
        Some(b)
    }

    pub fn u32(&mut self) -> Option<u32> {
        if self.buf.len() < 4 {
            return None;
        }
        let (n, rest) = self.buf.split_at(4);
        self.buf = rest;
        Some(u32::from_be_bytes([n[0], n[1], n[2], n[3]]))
    }

    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        if self.buf.len() < len {
            return None;
        }
        let (s, rest) = self.buf.split_at(len);
        self.buf = rest;
        Some(s)
    }

    pub fn string(&mut self) -> Option<String> {
        String::from_utf8(self.bytes()?.to_vec()).ok()
    }

    pub fn bool(&mut self) -> Option<bool> {
        self.u8().map(|b| b != 0)
    }

    pub fn rest(&self) -> &'a [u8] {
        self.buf
    }
}

/// Le contenu d'une trame (sans sa longueur) → la demande.
pub fn parse(payload: &[u8]) -> Result<Request, &'static str> {
    let mut r = Reader::new(payload);
    let kind = r.u8().ok_or("trame vide")?;
    match kind {
        REQUEST_IDENTITIES => Ok(Request::Identities),
        SIGN_REQUEST => {
            let key_blob = r.bytes().ok_or("clé manquante")?.to_vec();
            let data = r.bytes().ok_or("données manquantes")?.to_vec();
            let flags = r.u32().unwrap_or(0);
            Ok(Request::Sign { key_blob, data, flags })
        }
        EXTENSION => {
            let name = r.string().ok_or("nom d'extension illisible")?;
            if name == "session-bind@openssh.com" {
                let host_key = r.bytes().ok_or("clé d'hôte manquante")?.to_vec();
                let session_id = r.bytes().ok_or("id de session manquant")?.to_vec();
                let signature = r.bytes().ok_or("signature manquante")?.to_vec();
                let forwarding = r.bool().ok_or("drapeau de relais manquant")?;
                Ok(Request::SessionBind {
                    host_key,
                    session_id,
                    signature,
                    forwarding,
                })
            } else {
                Ok(Request::UnknownExtension(name))
            }
        }
        other => Ok(Request::Other(other)),
    }
}

fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    out.extend_from_slice(b);
}

/// La liste des clés : `(blob de la clé publique, commentaire)`.
pub fn identities_answer(ids: &[(Vec<u8>, String)]) -> Vec<u8> {
    let mut out = vec![IDENTITIES_ANSWER];
    out.extend_from_slice(&(ids.len() as u32).to_be_bytes());
    for (blob, comment) in ids {
        put_bytes(&mut out, blob);
        put_bytes(&mut out, comment.as_bytes());
    }
    out
}

pub fn sign_response(signature_blob: &[u8]) -> Vec<u8> {
    let mut out = vec![SIGN_RESPONSE];
    put_bytes(&mut out, signature_blob);
    out
}

/// Une trame complète : longueur puis contenu.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
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
    fn parses_what_openssh_sends() {
        assert_eq!(parse(&[REQUEST_IDENTITIES]), Ok(Request::Identities));

        let mut sign = vec![SIGN_REQUEST];
        sign.extend(string(b"KEY"));
        sign.extend(string(b"DATA"));
        sign.extend(RSA_SHA2_512.to_be_bytes());
        assert_eq!(
            parse(&sign),
            Ok(Request::Sign { key_blob: b"KEY".to_vec(), data: b"DATA".to_vec(), flags: RSA_SHA2_512 })
        );

        let mut bind = vec![EXTENSION];
        bind.extend(string(b"session-bind@openssh.com"));
        bind.extend(string(b"HOSTKEY"));
        bind.extend(string(b"SID"));
        bind.extend(string(b"SIG"));
        bind.push(1);
        assert_eq!(
            parse(&bind),
            Ok(Request::SessionBind {
                host_key: b"HOSTKEY".to_vec(),
                session_id: b"SID".to_vec(),
                signature: b"SIG".to_vec(),
                forwarding: true
            })
        );

        let mut query = vec![EXTENSION];
        query.extend(string(b"query"));
        assert_eq!(parse(&query), Ok(Request::UnknownExtension("query".into())));
        // Ajouter une clé (17) : compris comme « autre », donc refusé.
        assert_eq!(parse(&[17, 0, 0]), Ok(Request::Other(17)));
    }

    #[test]
    fn refuses_truncated_frames() {
        assert!(parse(&[]).is_err());
        assert!(parse(&[SIGN_REQUEST, 0, 0, 0, 9, b'x']).is_err());
        let mut bind = vec![EXTENSION];
        bind.extend(string(b"session-bind@openssh.com"));
        bind.extend(string(b"HOSTKEY"));
        assert!(parse(&bind).is_err());
    }

    #[test]
    fn encodes_answers() {
        let a = identities_answer(&[(b"K1".to_vec(), "prod".into())]);
        assert_eq!(a, [vec![IDENTITIES_ANSWER, 0, 0, 0, 1], string(b"K1"), string(b"prod")].concat());
        assert_eq!(sign_response(b"S"), [vec![SIGN_RESPONSE], string(b"S")].concat());
        assert_eq!(frame(&[SUCCESS]), vec![0, 0, 0, 1, SUCCESS]);
    }
}
