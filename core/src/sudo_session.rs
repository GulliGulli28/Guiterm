//! Un shell root persistant sur une connexion SSH, et la conversation qui
//! sert à l'ouvrir.
//!
//! ## Pourquoi un shell tenu ouvert plutôt qu'un `sudo` par commande
//!
//! `sudo` mémorise l'authentification dans un « ticket », mais celui-ci est
//! attaché au terminal (`tty_tickets`, activé par défaut depuis sudo 1.7) et,
//! faute de terminal, à la session/au processus parent. Or chaque commande
//! lancée sur une connexion SSH ouvre un canal `exec` neuf, donc un processus
//! neuf : un `sudo` par commande redemanderait le mot de passe **à chaque
//! action**, y compris à chaque dossier listé pendant une navigation.
//!
//! D'où ce module : on lance **une fois** `sudo -S sh`, on lui donne le mot de
//! passe sur son entrée standard, et le `sh` qui en résulte — root, vivant —
//! reçoit ensuite toutes les commandes du panneau. Le mot de passe n'est
//! demandé qu'une fois par panneau élevé, et il ne quitte jamais la mémoire.
//!
//! ## Les octets des fichiers ne passent pas par ici
//!
//! Ce canal sert aux **métadonnées** (lister, créer, déplacer, `du`, `find`,
//! `tar`) et à quelques copies faites sur place. Le contenu des fichiers
//! transite par SFTP ordinaire à travers un fichier de transit — voir
//! [`crate::sudo_pane`]. Faire passer des mégaoctets à travers un shell
//! obligerait à les encoder (base64, +33 %) et retirerait la progression et
//! l'annulation que `SftpClient` sait déjà faire.
//!
//! ## Cadrage
//!
//! Un `sh` ne délimite pas ses réponses. Après chaque commande on lui fait
//! donc imprimer une **sentinelle** portant le code de retour sur la sortie
//! standard, et une autre sur la sortie d'erreur ; le lecteur accumule jusqu'à
//! avoir vu les deux. La sentinelle contient un identifiant tiré au hasard à
//! l'ouverture de la session : aucune sortie de commande ne peut la contenir
//! par accident.
use crate::shell::quote;
use crate::ssh::Connection;
use russh::ChannelMsg;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc, oneshot};
use zeroize::Zeroizing;

/// Ce que `sudo -n` répond quand l'utilisateur a le droit mais doit taper son
/// mot de passe. Comparé à la sortie d'un programme externe, donc en anglais —
/// même exception que `cloud_cli`/`netdiag`, voir
/// `core/tests/error_messages_are_french.rs`.
const NEEDS_PASSWORD: &str = "a password is required";

/// Ce que `sudo` répond à un mot de passe refusé. Anglais pour la même raison.
const BAD_PASSWORD: &[&str] = &["incorrect password", "sorry, try again"];

/// Au-delà, on considère que `sudo` n'ouvrira jamais le shell — un serveur
/// avec `requiretty` laisserait sinon l'interface attendre sans fin.
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

/// Ce dont a besoin celui qui veut élever un panneau : de quoi savoir s'il
/// faut demander un mot de passe, et lequel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SudoNeed {
    /// `sudo -n` passe déjà : `NOPASSWD`, ou un ticket encore valide.
    NoPassword,
    /// L'utilisateur a le droit, mais doit s'authentifier.
    Password,
}

/// Interroge l'hôte pour savoir si `sudo` demandera un mot de passe.
///
/// Lancé **avant** d'ouvrir le shell élevé, et pas fusionné avec lui : sans
/// cette réponse, on ne saurait pas s'il faut écrire un mot de passe sur
/// l'entrée standard de `sudo -S`, et l'écrire alors qu'il n'en veut pas le
/// ferait consommer par le `sh` lancé derrière — qui l'exécuterait comme une
/// commande et l'imprimerait dans un message d'erreur.
pub async fn probe(connection: &Connection) -> anyhow::Result<SudoNeed> {
    let output = crate::ssh::run_command_capture(connection, "sudo -n -- true").await?;
    interpret_probe(output.exit_code, &output.stderr)
}

/// La décision, séparée de l'aller-retour réseau : c'est elle qui décide si
/// l'interface demande un mot de passe, et elle se teste sans serveur.
pub fn interpret_probe(exit_code: Option<i32>, stderr: &str) -> anyhow::Result<SudoNeed> {
    if exit_code == Some(0) {
        return Ok(SudoNeed::NoPassword);
    }
    if stderr.to_lowercase().contains(NEEDS_PASSWORD) {
        return Ok(SudoNeed::Password);
    }
    let detail = stderr.trim();
    if detail.is_empty() {
        anyhow::bail!("sudo est indisponible sur cet hôte (code {exit_code:?})");
    }
    anyhow::bail!("sudo a refusé : {detail}");
}

/// Ce qu'une commande a produit.
pub struct SudoOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
}

struct Request {
    command: String,
    reply: oneshot::Sender<anyhow::Result<SudoOutput>>,
}

/// Un `sh` root vivant, et le canal pour lui parler.
///
/// Le mot de passe est conservé (dans un [`Zeroizing`], effacé à la
/// destruction) pour pouvoir rouvrir le shell si la connexion est rétablie —
/// c'est le « mémorisé pour l'onglet » côté interface. Il n'est jamais écrit
/// sur disque, ni confié au trousseau, ni au coffre.
pub struct SudoSession {
    requests: mpsc::Sender<Request>,
    /// Sérialise les commandes : le cadrage par sentinelle suppose qu'une
    /// seule réponse est en vol à la fois. Deux copies simultanées dans le
    /// même panneau mélangeraient sinon leurs sorties.
    lock: Mutex<()>,
    password: Option<Zeroizing<String>>,
}

/// Volontairement écrit à la main : un `derive` imprimerait le mot de passe
/// mémorisé dans le moindre `unwrap` d'un `Result<SudoSession, _>`.
impl std::fmt::Debug for SudoSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SudoSession")
            .field("password", &self.password.as_ref().map(|_| "<masqué>"))
            .finish()
    }
}

impl SudoSession {
    /// Ouvre le shell élevé. `password` doit être `Some` exactement quand
    /// [`probe`] a répondu [`SudoNeed::Password`].
    pub async fn open(connection: &Connection, password: Option<String>) -> anyhow::Result<Self> {
        // `-p ''` : l'invite de `sudo` partirait sinon sur la sortie d'erreur
        // de la toute première commande. `--` ferme les options de sudo pour
        // que `sh` ne puisse pas être pris pour l'une d'elles.
        let launcher = match password {
            Some(_) => "sudo -S -p '' -- sh",
            None => "sudo -n -- sh",
        };
        Self::open_with_launcher(connection, launcher, password).await
    }

    /// La même chose, en laissant choisir la commande qui ouvre le shell.
    ///
    /// Existe pour les tests d'intégration, qui ont besoin de vérifier tout ce
    /// qui est bâti là-dessus — cadrage, listing, transferts par fichier de
    /// transit — sans dépendre d'un `sudo` utilisable sans mot de passe sur la
    /// machine qui les exécute (`sudo -n` échoue sur un poste de dev ordinaire
    /// comme sur bien des runners). Le reste de l'application appelle
    /// [`Self::open`].
    pub async fn open_with_launcher(
        connection: &Connection,
        launcher: &str,
        password: Option<String>,
    ) -> anyhow::Result<Self> {
        let sentinel = format!("__GUITERM_SUDO_{}__", uuid::Uuid::new_v4().simple());
        let channel = connection.target().channel_open_session().await?;
        channel.exec(true, launcher).await?;

        if let Some(secret) = &password {
            let mut line = Zeroizing::new(secret.clone());
            line.push('\n');
            channel.data(line.as_bytes()).await?;
        }

        let (tx, rx) = mpsc::channel::<Request>(8);
        tokio::spawn(pump(channel, rx, sentinel));

        let session = Self {
            requests: tx,
            lock: Mutex::new(()),
            password: password.map(Zeroizing::new),
        };

        // Première commande, qui vaut aussi épreuve du mot de passe : tant que
        // `sudo` n'a pas accepté, il n'y a pas de `sh` pour répondre.
        let probe = tokio::time::timeout(OPEN_TIMEOUT, session.run("true", &[])).await;
        match probe {
            Err(_) => anyhow::bail!(
                "sudo n'a pas répondu en {} s — l'hôte demande peut-être un terminal (requiretty)",
                OPEN_TIMEOUT.as_secs()
            ),
            Ok(Err(e)) => {
                let lowered = e.to_string().to_lowercase();
                if BAD_PASSWORD.iter().any(|marker| lowered.contains(marker)) {
                    anyhow::bail!("mot de passe sudo refusé");
                }
                Err(e.context("ouverture du shell élevé"))
            }
            Ok(Ok(_)) => Ok(session),
        }
    }

    /// `true` si cette session a mémorisé un mot de passe — ce qui permet à
    /// l'appelant de la rouvrir sans redemander à l'utilisateur.
    pub fn remembered_password(&self) -> Option<String> {
        self.password.as_ref().map(|p| p.to_string())
    }

    /// Lance `sh -c '<script>' sh <args...>` en root et rend sa sortie
    /// standard. Échoue en rapportant la sortie d'erreur.
    ///
    /// Les arguments sont **positionnels** (`$1`, `$2`, …), jamais interpolés
    /// dans le texte du script — même convention que
    /// [`crate::remote_shell_pane::LIST_SCRIPT`] et [`crate::pane_ops`].
    pub async fn run_script(&self, script: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let mut command = format!("sh -c {} sh", quote(script));
        for arg in args {
            command.push(' ');
            command.push_str(&quote(arg));
        }
        let output = self.run(&command, &[]).await?;
        if output.exit_code != 0 {
            let detail = output.stderr.trim();
            anyhow::bail!(
                "commande élevée en échec (code {}){}",
                output.exit_code,
                if detail.is_empty() { String::new() } else { format!(" : {detail}") }
            );
        }
        Ok(output.stdout)
    }

    async fn run(&self, command: &str, args: &[&str]) -> anyhow::Result<SudoOutput> {
        let mut line = command.to_string();
        for arg in args {
            line.push(' ');
            line.push_str(&quote(arg));
        }
        let _serialised = self.lock.lock().await;
        let (reply, wait) = oneshot::channel();
        self.requests
            .send(Request { command: line, reply })
            .await
            .map_err(|_| anyhow::anyhow!("le shell élevé s'est arrêté"))?;
        wait.await.map_err(|_| anyhow::anyhow!("le shell élevé s'est arrêté"))?
    }
}

/// Écrit les commandes sur l'entrée du shell et découpe ses réponses.
///
/// Chaque commande part avec son entrée standard fermée (`< /dev/null`) : une
/// commande qui lirait l'entrée avalerait les lignes suivantes — dont sa
/// propre sentinelle, ce qui bloquerait le lecteur pour toujours.
async fn pump(mut channel: russh::Channel<russh::client::Msg>, mut rx: mpsc::Receiver<Request>, sentinel: String) {
    let out_marker = format!("\n{sentinel}");
    let err_marker = format!("{sentinel}\n");

    while let Some(request) = rx.recv().await {
        let script = format!(
            "{{ {} ; }} < /dev/null\n__guiterm_rc=$?\nprintf '\\n%s%d\\n' {} \"$__guiterm_rc\"\nprintf '%s\\n' {} >&2\n",
            request.command,
            quote(&sentinel),
            quote(&sentinel),
        );
        if channel.data(script.as_bytes()).await.is_err() {
            let _ = request.reply.send(Err(anyhow::anyhow!("le shell élevé s'est arrêté")));
            break;
        }

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut done: Option<(Vec<u8>, String, i32)> = None;
        let mut closed = false;

        while done.is_none() {
            let Some(message) = channel.wait().await else {
                closed = true;
                break;
            };
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                // Le shell est mort — sur un mot de passe refusé, `sudo` sort
                // sans jamais avoir lancé le `sh` qui imprimerait la
                // sentinelle. On ne s'arrête pas sur `Eof` : la sentinelle
                // peut encore arriver, et attendre `Close` est le même choix
                // que `ssh::run_command_streaming`.
                ChannelMsg::Close => {
                    closed = true;
                    break;
                }
                _ => {}
            }
            let Some((body, code)) = split_stdout(&stdout, out_marker.as_bytes()) else {
                continue;
            };
            let Some(errors) = split_stderr(&stderr, err_marker.as_bytes()) else {
                continue;
            };
            done = Some((body, errors, code));
        }

        let answer = match done {
            Some((stdout, stderr, exit_code)) => Ok(SudoOutput { stdout, stderr, exit_code }),
            None => {
                let detail = String::from_utf8_lossy(&stderr).trim().to_string();
                Err(if detail.is_empty() {
                    anyhow::anyhow!("le shell élevé s'est arrêté")
                } else {
                    anyhow::anyhow!("le shell élevé s'est arrêté : {detail}")
                })
            }
        };
        let _ = request.reply.send(answer);
        if closed {
            break;
        }
    }
}

/// Coupe la sortie standard sur la dernière sentinelle et lit le code de
/// retour qui la suit. `None` tant que la sentinelle complète n'est pas
/// arrivée — un morceau TCP peut la couper en deux.
pub fn split_stdout(buffer: &[u8], marker: &[u8]) -> Option<(Vec<u8>, i32)> {
    let start = find_last(buffer, marker)?;
    let after = &buffer[start + marker.len()..];
    let newline = after.iter().position(|b| *b == b'\n')?;
    let code: i32 = std::str::from_utf8(&after[..newline]).ok()?.trim().parse().ok()?;
    Some((buffer[..start].to_vec(), code))
}

/// Idem pour la sortie d'erreur, qui ne porte pas de code.
pub fn split_stderr(buffer: &[u8], marker: &[u8]) -> Option<String> {
    let start = find_last(buffer, marker)?;
    Some(String::from_utf8_lossy(&buffer[..start]).into_owned())
}

fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).rev().find(|i| &haystack[*i..*i + needle.len()] == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_body_and_the_exit_code() {
        let marker = b"\n__S__";
        let buffer = b"une ligne\nune autre\n__S__0\n";
        let (body, code) = split_stdout(buffer, marker).expect("sentinelle complète");
        assert_eq!(body, b"une ligne\nune autre");
        assert_eq!(code, 0);
    }

    /// Le cas qui bloquerait le lecteur pour toujours s'il était mal traité :
    /// la sentinelle coupée en deux par le découpage réseau.
    #[test]
    fn waits_until_the_sentinel_is_complete() {
        assert!(split_stdout(b"sortie\n__S", b"\n__S__").is_none());
        assert!(split_stdout(b"sortie\n__S__", b"\n__S__").is_none(), "code de retour pas encore lu");
        assert!(split_stdout(b"sortie\n__S__12", b"\n__S__").is_none(), "ligne pas terminée");
        assert_eq!(split_stdout(b"sortie\n__S__12\n", b"\n__S__").unwrap().1, 12);
    }

    /// Une sortie qui contiendrait elle-même la sentinelle (impossible en
    /// pratique, l'identifiant est tiré au hasard) : c'est la **dernière** qui
    /// compte, sinon le corps serait tronqué.
    #[test]
    fn the_last_sentinel_wins() {
        let (body, code) = split_stdout(b"a\n__S__9\nb\n__S__0\n", b"\n__S__").unwrap();
        assert_eq!(body, b"a\n__S__9\nb");
        assert_eq!(code, 0);
    }

    #[test]
    fn an_empty_output_is_not_confused_with_a_missing_sentinel() {
        let (body, code) = split_stdout(b"\n__S__0\n", b"\n__S__").expect("sentinelle complète");
        assert!(body.is_empty());
        assert_eq!(code, 0);
    }

    #[test]
    fn a_password_prompt_is_told_apart_from_a_refusal() {
        assert_eq!(interpret_probe(Some(0), "").unwrap(), SudoNeed::NoPassword);
        assert_eq!(
            interpret_probe(Some(1), "sudo: a password is required").unwrap(),
            SudoNeed::Password
        );
        // Pas dans le fichier sudoers : il n'y a rien à demander, l'utilisateur
        // doit le savoir plutôt que de se voir proposer une invite inutile.
        let refused = interpret_probe(Some(1), "sudo: glorin n'est pas dans le fichier sudoers.")
            .expect_err("un refus n'est pas une demande de mot de passe");
        assert!(refused.to_string().contains("sudoers"), "{refused}");
        // `sudo` absent : la commande sort en 127 sans rien dire d'exploitable.
        assert!(interpret_probe(Some(127), "  ").is_err());
    }

    #[test]
    fn stderr_stops_at_its_own_sentinel() {
        assert_eq!(split_stderr(b"cp: refus\n__S__\n", b"__S__\n").unwrap(), "cp: refus\n");
        assert!(split_stderr(b"cp: refus\n", b"__S__\n").is_none());
    }
}
