use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use termius_core::model::{PortForwardId, Workspace};
use termius_core::mongo_client::MongoSession;
use termius_core::pane_ops::ShellExec;
use termius_core::port_forward::ActiveForward;
use termius_core::redis_client::RedisSession;
use termius_core::sftp::RemoteFileClient;
use termius_core::sql::SqlSession;
use termius_core::ssh::ShellInput;
use termius_core::ssh_pool::SshLease;
use tokio::sync::mpsc;

/// Which backend a [`TerminalSession`] actually runs over. Only `Ssh` needs
/// to retain anything beyond the input channel: dropping the lease would let
/// the SSH connection the shell runs on close, if nothing else holds one (see
/// `termius_core::ssh_pool`). A Docker exec or K8s exec session owns its
/// resources entirely inside the task spawned by
/// `termius_core::docker::open_exec`/`termius_core::k8s::open_exec`, so
/// there's nothing extra to keep alive.
pub enum TerminalBackend {
    Ssh(#[allow(dead_code)] SshLease),
    Docker,
    K8s,
}

/// A live interactive shell (SSH, Docker exec, or K8s exec), bridged onto
/// the same plain byte-stream channels regardless of backend.
pub struct TerminalSession {
    #[allow(dead_code)]
    pub backend: TerminalBackend,
    pub input: mpsc::Sender<ShellInput>,
}

/// One side of an open transfer tab: `client: None` means the local
/// filesystem, `Some` an SFTP (SSH), Docker-exec, or K8s-exec pane — see
/// `termius_core::sftp::RemoteFileClient`. `connection` only ever holds
/// something for the SFTP case (keeping the SSH session the SFTP subsystem
/// channel rides on alive) — a Docker pane's `bollard::Docker`/K8s pane's
/// `kube::Client` handle already keeps everything it needs alive internally
/// (including, when tunnelled over SSH, the underlying `Connection` — see
/// `termius_core::docker::connect_via_ssh`'s doc comment), so `None` there
/// isn't a leak.
pub struct Pane {
    /// Derrière un `Arc` pour qu'une copie lancée en tâche de fond puisse en
    /// garder une part le temps de finir : depuis que `copy_entries` rend la
    /// main tout de suite, l'onglet peut être fermé pendant le transfert, et
    /// lâcher le dernier bail fermerait la connexion SSH sous le canal SFTP
    /// en cours d'utilisation (voir `ssh_pool::SshLease`).
    pub connection: Option<Arc<SshLease>>,
    pub client: Option<Arc<dyn RemoteFileClient>>,
    /// Comment lancer un script `sh` du côté où vivent les fichiers du
    /// panneau — `None` pour le panneau local (Windows n'a pas de `sh`, ces
    /// opérations s'y font en Rust). Rangé ici plutôt que dérivé de `client`
    /// : `Arc<dyn RemoteFileClient>` ne se re-transtype pas en
    /// `Arc<dyn ShellExec>`, alors qu'à l'ouverture du panneau le type concret
    /// est encore connu et se coerce vers les deux. Voir
    /// `termius_core::pane_ops` pour ce que ça permet (taille d'un dossier,
    /// recherche récursive, archivage — tous exécutés sur place).
    pub exec: Option<Arc<dyn ShellExec>>,
    /// Les versions **non élevées** de `client`/`exec`, mises de côté quand le
    /// panneau passe en root : redescendre est alors un simple échange, sans
    /// rouvrir de session SFTP ni relister le dossier depuis zéro.
    pub plain_client: Option<Arc<dyn RemoteFileClient>>,
    pub plain_exec: Option<Arc<dyn ShellExec>>,
    /// Le shell root, tant que le panneau est élevé. Le garder ici, et pas
    /// seulement dans le `SudoPaneClient`, c'est ce qui le fait vivre aussi
    /// longtemps que le panneau : le `sh` distant meurt dès que son canal est
    /// lâché, et il faudrait alors retaper le mot de passe.
    pub sudo: Option<Arc<termius_core::sudo_session::SudoSession>>,
    /// « Retenu pour cet onglet » : le mot de passe sudo reste en mémoire vive
    /// tant que ce panneau existe, pour qu'une bascule éteinte puis rallumée
    /// ne le redemande pas. Jamais écrit sur disque, jamais confié au coffre
    /// ni au trousseau, effacé avec le panneau.
    pub sudo_password: Option<zeroize::Zeroizing<String>>,
}

impl Pane {
    /// Le système de fichiers de la machine qui fait tourner l'app : rien à
    /// tenir, et aucune élévation possible (c'est déjà la session de
    /// l'utilisateur, et Windows n'a pas de `sudo`).
    pub fn local() -> Self {
        Self {
            connection: None,
            client: None,
            exec: None,
            plain_client: None,
            plain_exec: None,
            sudo: None,
            sudo_password: None,
        }
    }

    /// Un panneau distant, non élevé. `plain_*` part sur les mêmes valeurs que
    /// `client`/`exec` : c'est l'état auquel « repasser en utilisateur
    /// ordinaire » revient.
    pub fn remote(
        connection: Option<Arc<SshLease>>,
        client: Arc<dyn RemoteFileClient>,
        exec: Arc<dyn ShellExec>,
    ) -> Self {
        Self {
            connection,
            client: Some(client.clone()),
            exec: Some(exec.clone()),
            plain_client: Some(client),
            plain_exec: Some(exec),
            sudo: None,
            sudo_password: None,
        }
    }
}

pub struct ForwardSession {
    /// The lease, not a bare `Arc<Connection>`: a tunnel outlives the call
    /// that opened it, so it has to hold the pool slot for its whole life —
    /// see `termius_core::ssh_pool::SshLease`'s doc comment.
    pub connection: SshLease,
    pub active: ActiveForward,
}

/// Newtype that asserts Send+Sync for the PTY master.
/// portable-pty 0.8 does not mark MasterPty: Send even though the
/// underlying fd is safe to use from any thread (guarded by our Mutex).
pub struct SendMasterPty(pub Box<dyn portable_pty::MasterPty>);
unsafe impl Send for SendMasterPty {}
unsafe impl Sync for SendMasterPty {}

pub struct LocalTerminalSession {
    pub master: SendMasterPty,
    pub writer: Box<dyn std::io::Write + Send>,
}

/// A live embedded-RDP session — see `commands::rdp_view` and CLAUDE.md's
/// "Pourquoi un processus RDP séparé" section. `child` is kept around solely
/// so `close_rdp_view` can kill the sidecar process; the actual frame data
/// flows to the frontend via `rdp-view-*` events, not through this struct.
pub struct RdpViewSession {
    pub child: tauri_plugin_shell::process::CommandChild,
}

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Workspace>,
    /// Le compte GuiVault de cette machine et sa session (voir
    /// `termius_core::guivault`). `Arc` : la boucle de synchronisation
    /// automatique en garde une part hors de tout `State`.
    pub guivault: Arc<termius_core::guivault::Manager>,
    /// Une seule synchronisation à la fois : un `try_lock` raté veut dire
    /// « déjà en cours », pas « attendre » — deux synchros qui se suivent
    /// n'apportent rien de plus qu'une.
    pub guivault_sync_lock: tokio::sync::Mutex<()>,
    /// « Transférer le profil local dans ce compte » demandé sur une
    /// connexion arrêtée au second facteur — rejoué à `guivault_login_totp`.
    pub guivault_pending_adopt: Mutex<bool>,
    /// Les items chiffrés du compte, tels que le panneau « Coller depuis
    /// GuiVault » les a reçus — un cache par révision de vault, jamais du
    /// clair (voir `termius_core::guivault::browse`). Vidé à la déconnexion.
    pub guivault_browse: Mutex<termius_core::guivault::browse::Cache>,
    pub terminals: Mutex<HashMap<String, TerminalSession>>,
    pub local_terminals: Mutex<HashMap<String, LocalTerminalSession>>,
    pub panes: Mutex<HashMap<String, Pane>>,
    pub forwards: Mutex<HashMap<PortForwardId, ForwardSession>>,
    pub rdp_views: Mutex<HashMap<String, RdpViewSession>>,
    /// Live SQL connections (pool + tunnel, if tunnelled), keyed by a
    /// generated session id the frontend passes back on every subsequent
    /// call — same "opaque id → live resource" shape as `panes`.
    pub sql_sessions: Mutex<HashMap<String, SqlSession>>,
    /// Live Redis connections — same "opaque id → live resource" shape as
    /// `sql_sessions`, kept separate since a `RedisSession` isn't a `SqlPool`
    /// (see `termius_core::redis_client`'s module doc comment).
    pub redis_sessions: Mutex<HashMap<String, RedisSession>>,
    /// Live MongoDB connections — same "opaque id → live resource" shape as
    /// `sql_sessions`/`redis_sessions` (see `termius_core::mongo_client`'s
    /// module doc comment for why it's a separate client).
    pub mongo_sessions: Mutex<HashMap<String, MongoSession>>,
    /// One cancellation flag per in-flight `upload_file`/`download_file` transfer, keyed by transfer id.
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Command history for local-terminal ghost-text suggestions, most recent
    /// last. Entries carry a timestamp for the activity journal; ghost-text
    /// only ever sees `command_history::commands(...)`.
    pub local_history: Mutex<Vec<termius_core::command_history::CommandEntry>>,
    /// Same, for SSH terminals — one list shared across all hosts (each entry
    /// records the host of its most recent use).
    pub ssh_history: Mutex<Vec<termius_core::command_history::CommandEntry>>,
    /// Requêtes SQL déjà exécutées, la plus récente en dernier. Même stockage
    /// que les deux ci-dessus — `command_history` ne suppose rien d'un shell,
    /// et sa déduplication (une requête rejouée remonte au lieu d'être
    /// dupliquée) est exactement ce qu'on veut d'un historique de requêtes.
    /// Le champ `host` d'une entrée porte ici le **libellé de la connexion**.
    pub sql_history: Mutex<Vec<termius_core::command_history::CommandEntry>>,
    /// Past fleet runs (audit trail), newest first — persisted to `fleet_history.json`.
    pub fleet_history: Mutex<Vec<termius_core::fleet_history::FleetRun>>,
    /// Exécutions de runbooks passées, la plus récente en tête — persistées
    /// dans `runbook_history.json`. Un fichier à part de l'historique de
    /// flotte, voir `termius_core::runbook_history` pour pourquoi.
    pub runbook_history: Mutex<Vec<termius_core::runbook_history::RunbookRun>>,
    /// Un drapeau d'annulation par exécution de runbook en cours, par id de
    /// run. Consulté **entre** deux étapes : une étape déjà partie va au bout
    /// sur ses cibles, parce qu'interrompre un `apt-get` à mi-chemin laisserait
    /// une machine dans un état que la procédure ne décrit nulle part.
    pub runbook_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// L'approbation qu'une exécution attend, par id de run.
    ///
    /// **Une seule à la fois par exécution** — la boucle est séquentielle, elle
    /// ne peut pas être bloquée sur deux étapes. D'où la clé : c'est aussi ce
    /// qui permet à `cancel_runbook` de retrouver l'attente en cours et de la
    /// refuser, au lieu de laisser l'utilisateur devant un bouton « Arrêter »
    /// sans effet pendant dix minutes. Le rang d'étape est gardé avec le canal
    /// pour qu'une réponse tardive à l'étape précédente ne réponde pas à
    /// celle-ci.
    pub runbook_approvals: Mutex<HashMap<String, (usize, tokio::sync::oneshot::Sender<bool>)>>,
    /// In-flight keyboard-interactive (MFA) prompts, keyed by the id sent to
    /// the frontend with the `ssh-auth-prompt` event. Each entry is an SSH
    /// handshake parked mid-authentication, waiting for the user's answers —
    /// see `commands::interactive_auth`. Never holds the answers themselves,
    /// only the channel they'll arrive on.
    pub auth_prompts: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Vec<String>>>>,
    /// Remote files currently open in the user's own editor, keyed by edit id
    /// — each holds a private temp copy plus what's needed to push it back.
    /// See `termius_core::remote_edit`, and `commands::remote_edit` for when
    /// the push-back actually happens (on the app regaining focus, not from a
    /// background watcher).
    pub remote_edits: Mutex<HashMap<String, termius_core::remote_edit::RemoteEdit>>,
    /// One recording slot per live terminal session, keyed by session id.
    ///
    /// The slot is created empty when the session opens and handed to the
    /// task that pumps its output, so starting a recording later only has to
    /// fill it — the output path never looks the map up per chunk. `None`
    /// means "this session is not being recorded", which is the normal case.
    pub recorders: Mutex<HashMap<String, RecorderSlot>>,
}

/// See [`AppState::recorders`]. Shared between the command that starts/stops a
/// recording and the task writing into it.
pub type RecorderSlot = Arc<Mutex<Option<termius_core::session_record::SessionRecorder>>>;
