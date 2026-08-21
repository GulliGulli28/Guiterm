use termius_core::sync_ext::MutexExt;
use crate::state::{AppState, Pane};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use termius_core::docker;
use termius_core::docker_pane::DockerPaneClient;
use termius_core::k8s;
use termius_core::k8s_pane::K8sPaneClient;
use termius_core::model::HostId;
use termius_core::pane_ops::{self, ArchiveFormat, FindOutcome, PaneExec, ShellExec, SshShellExec};
use termius_core::sftp::{Entry, RemoteFileClient, SftpClient};
use termius_core::ssh_pool;
use termius_core::transfer::{self, PaneRef};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PaneSource {
    Local,
    Remote {
        #[serde(rename = "hostId")]
        host_id: HostId,
    },
    /// A Docker exec host's container filesystem — `container_id` picked the
    /// same way `connect_docker_exec` picks one (see `HostsPanel.tsx`'s
    /// `openDockerPicker`/`ConnectionPickerModal`), just for a pane instead
    /// of a shell. Both fields need an explicit `rename`: `rename_all` on an
    /// internally-tagged enum only renames the variant names (the `"kind"`
    /// values), not struct-variant field names — see `rdp_ipc::ClientMessage`
    /// in CLAUDE.md for the same gotcha hit before, apparently not
    /// remembered hard enough to avoid repeating it here.
    Docker {
        #[serde(rename = "hostId")]
        host_id: HostId,
        #[serde(rename = "containerId")]
        container_id: String,
    },
    /// A K8s exec host's pod filesystem — same idea as `Docker`, `pod_name`/
    /// `container_name` picked the same way `connect_k8s_exec` picks them.
    /// Every field needs its own explicit `rename` for the same reason as
    /// `Docker`'s above.
    K8s {
        #[serde(rename = "hostId")]
        host_id: HostId,
        #[serde(rename = "podName")]
        pod_name: String,
        #[serde(rename = "containerName")]
        container_name: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneOpened {
    pub pane_id: String,
    pub cwd: String,
    pub entries: Vec<Entry>,
}

#[tauri::command]
pub async fn open_pane(
    state: State<'_, AppState>,
    source: PaneSource,
) -> Result<PaneOpened, String> {
    let pane_id = Uuid::new_v4().to_string();
    match source {
        PaneSource::Local => {
            let cwd = termius_core::local_fs::home_dir();
            let entries = termius_core::local_fs::list(&cwd).map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: None,
                    client: None,
                    exec: None,
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
        PaneSource::Remote { host_id } => {
            let workspace = state.workspace.lock_recover().clone();
            let connection = ssh_pool::acquire(&workspace, host_id)
                .await
                .map_err(|e| e.to_string())?;
            let client = Arc::new(
                SftpClient::open(&connection)
                    .await
                    .map_err(|e| e.to_string())?,
            );
            let cwd = client.home_dir().await.map_err(|e| e.to_string())?;
            let entries = client.list(&cwd).await.map_err(|e| e.to_string())?;
            // Les opérations récursives (taille, recherche, archivage) partent
            // sur un canal `exec` de cette même connexion — le sous-système
            // SFTP n'exécute rien, et rouvrir une connexion pour un `du`
            // gaspillerait un TCP + poignée de main + auth (voir
            // `termius_core::pane_ops`).
            let exec: Arc<dyn ShellExec> = Arc::new(SshShellExec::new(connection.connection()));
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: Some(Arc::new(connection)),
                    client: Some(client),
                    exec: Some(exec),
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
        PaneSource::Docker { host_id, container_id } => {
            let workspace = state.workspace.lock_recover().clone();
            let host = workspace.host(host_id).cloned().ok_or_else(|| "hôte inconnu".to_string())?;
            let docker = docker::connect_for_host(&workspace, &host).await.map_err(|e| e.to_string())?;
            let pane_client = Arc::new(DockerPaneClient::new(docker, container_id));
            // Le même objet vu par ses deux traits (voir `Pane::exec`).
            let exec: Arc<dyn ShellExec> = pane_client.clone();
            let client: Arc<dyn RemoteFileClient> = pane_client;
            // No SFTP-equivalent "home directory" query for an arbitrary
            // container — `/` is always a valid starting point, unlike
            // guessing at a user's home which may not even exist in a
            // minimal image.
            let cwd = "/".to_string();
            let entries = client.list(&cwd).await.map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: None,
                    client: Some(client),
                    exec: Some(exec),
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
        PaneSource::K8s { host_id, pod_name, container_name } => {
            let workspace = state.workspace.lock_recover().clone();
            let host = workspace.host(host_id).cloned().ok_or_else(|| "hôte inconnu".to_string())?;
            let client_conn = k8s::connect(&host.address).await.map_err(|e| e.to_string())?;
            let pane_client =
                Arc::new(K8sPaneClient::new(client_conn, host.username.clone(), pod_name, container_name));
            // Même raison que l'arm Docker ci-dessus.
            let exec: Arc<dyn ShellExec> = pane_client.clone();
            let client: Arc<dyn RemoteFileClient> = pane_client;
            // Same reasoning as the Docker arm: no SFTP-equivalent "home
            // directory" query for an arbitrary pod, `/` always exists.
            let cwd = "/".to_string();
            let entries = client.list(&cwd).await.map_err(|e| e.to_string())?;
            state.panes.lock_recover().insert(
                pane_id.clone(),
                Pane {
                    connection: None,
                    client: Some(client),
                    exec: Some(exec),
                },
            );
            Ok(PaneOpened {
                pane_id,
                cwd,
                entries,
            })
        }
    }
}

#[tauri::command]
pub fn close_pane(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    state.panes.lock_recover().remove(&pane_id);
    Ok(())
}

#[derive(Serialize)]
pub struct PaneListed {
    pub cwd: String,
    pub entries: Vec<Entry>,
}

/// Le bail SSH d'un panneau, à garder le temps d'une opération lancée en tâche
/// de fond — sans quoi fermer l'onglet pendant une copie fermerait la
/// connexion sous le transfert en cours. `None` pour un panneau local, Docker
/// ou K8s : rien à tenir de ce côté-là (voir `state::Pane`).
fn pane_lease(state: &AppState, pane_id: &str) -> Option<Arc<termius_core::ssh_pool::SshLease>> {
    state.panes.lock_recover().get(pane_id)?.connection.clone()
}

pub(crate) fn pane_ref(state: &AppState, pane_id: &str) -> Result<PaneRef, String> {
    let panes = state.panes.lock_recover();
    let pane = panes
        .get(pane_id)
        .ok_or_else(|| "pane inconnu".to_string())?;
    Ok(match &pane.client {
        Some(client) => PaneRef::Remote(client.clone()),
        None => PaneRef::Local,
    })
}

#[tauri::command]
pub async fn list_pane(
    state: State<'_, AppState>,
    pane_id: String,
    path: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    let entries = transfer::list(&reference, &path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd: path, entries })
}

/// Ce que l'utilisateur choisit quand un nom est déjà pris à destination.
///
/// La question ne se pose qu'au **premier niveau** — les entrées qu'il a
/// désignées. Plus profond, une arborescence recopiée par-dessus une autre
/// fusionne et remplace fichier par fichier : poser la question pour chaque
/// fichier d'un arbre de dix mille rendrait la copie impraticable, et
/// « fusionner » est ce qu'on attend d'un dossier qu'on recopie.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// Remplacer (pour un dossier : fusionner dedans).
    Overwrite,
    /// Copier à côté, sous un nom libre — `rapport (2).pdf`.
    KeepBoth,
    /// Ne pas copier cette entrée-là.
    Skip,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyConflict {
    pub name: String,
    /// Un dossier et un fichier ne posent pas la même question : l'un
    /// fusionnerait, l'autre serait remplacé.
    pub is_dir: bool,
}

/// Les noms de `names` déjà présents dans `dest_cwd`. Appelé avant une copie
/// pour pouvoir demander plutôt qu'écraser en silence — c'est ce que faisait
/// l'envoi jusqu'ici, le SFTP ouvrant sa cible en création-troncature.
#[tauri::command]
pub async fn check_copy_conflicts(
    state: State<'_, AppState>,
    dest_pane_id: String,
    dest_cwd: String,
    names: Vec<String>,
) -> Result<Vec<CopyConflict>, String> {
    let dest = pane_ref(&state, &dest_pane_id)?;
    let existing = transfer::list(&dest, &dest_cwd).await.map_err(|e| e.to_string())?;
    Ok(existing
        .into_iter()
        .filter(|entry| names.iter().any(|name| name == &entry.name))
        .map(|entry| CopyConflict { name: entry.name, is_dir: entry.is_dir })
        .collect())
}

/// Copie `entries` de `source_cwd` vers `dest_cwd`, en tâche de fond.
///
/// Rend un identifiant de transfert **tout de suite** au lieu d'attendre la
/// fin : la copie alimente ensuite `transfer-progress` / `transfer-done` /
/// `transfer-error`, comme un dépôt venu de l'Explorateur, et peut être
/// annulée par `cancel_transfer`. Avant, l'appel restait en vol jusqu'au
/// dernier octet — sans barre, sans annulation, et l'interface ne savait rien
/// dire pendant qu'un dossier de plusieurs gigaoctets traversait.
///
/// Tout le lot porte un seul identifiant : c'est un geste de l'utilisateur,
/// pas n copies indépendantes, et une barre par fichier n'apprendrait rien.
// Sept paramètres nommés plutôt qu'une structure : c'est la signature que voit
// le frontend, et un objet imbriqué de plus n'y apporterait rien.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn copy_entries(
    app: AppHandle,
    state: State<'_, AppState>,
    source_pane_id: String,
    source_cwd: String,
    entries: Vec<Entry>,
    dest_pane_id: String,
    dest_cwd: String,
    conflict: ConflictPolicy,
) -> Result<String, String> {
    let source = pane_ref(&state, &source_pane_id)?;
    let dest = pane_ref(&state, &dest_pane_id)?;
    let source_exec = pane_exec(&state, &source_pane_id)?;

    let transfer_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    state.transfers.lock_recover().insert(transfer_id.clone(), cancel.clone());

    // Tenus pour la durée de la copie, pas seulement pour celle de l'appel.
    let leases = (pane_lease(&state, &source_pane_id), pane_lease(&state, &dest_pane_id));

    let app_handle = app.clone();
    let id = transfer_id.clone();
    tokio::spawn(async move {
        let _leases = leases;
        // Le total d'abord, pour que la barre veuille dire quelque chose : un
        // `du` par dossier sélectionné (une seule commande côté hôte), la
        // taille déjà connue pour un fichier. Au pire on ne sait pas, et la
        // barre reste indéterminée plutôt que fausse.
        let total = batch_total(&source_exec, &source_cwd, &entries).await;
        let result = copy_batch(&source, &source_cwd, &entries, &dest, &dest_cwd, conflict, total, &id, &app_handle, &cancel).await;
        match result {
            Ok(()) => {
                let _ = app_handle.emit("transfer-done", TransferDoneEvent { transfer_id: id.clone() });
            }
            Err(e) => {
                let _ = app_handle.emit(
                    "transfer-error",
                    TransferErrorEvent { transfer_id: id.clone(), message: e.to_string() },
                );
            }
        }
        app_handle.state::<AppState>().transfers.lock_recover().remove(&id);
    });

    Ok(transfer_id)
}

/// Somme des octets à copier. Au mieux : un `du` par dossier, exécuté sur
/// l'hôte source (voir `pane_ops::dir_size`). Un dossier dont la taille est
/// refusée compte pour zéro plutôt que de faire échouer la copie qui, elle,
/// marcherait très bien.
async fn batch_total(exec: &PaneExec, cwd: &str, entries: &[Entry]) -> u64 {
    let mut total = 0u64;
    for entry in entries {
        if entry.is_dir && !entry.is_symlink {
            let path = termius_core::sftp::join(cwd, &entry.name);
            total += pane_ops::dir_size(exec, &path).await.unwrap_or(0);
        } else {
            total += entry.size;
        }
    }
    total
}

#[allow(clippy::too_many_arguments)]
async fn copy_batch(
    source: &PaneRef,
    source_cwd: &str,
    entries: &[Entry],
    dest: &PaneRef,
    dest_cwd: &str,
    conflict: ConflictPolicy,
    total: u64,
    transfer_id: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> anyhow::Result<()> {
    let app_for_report = app.clone();
    let id_for_report = transfer_id.to_string();
    // Une émission par morceau reçu serait un événement tous les 256 Ko : on
    // n'en garde qu'un par tranche de 1 %, ou dès qu'on change de fichier —
    // au-delà, ce sont des messages que l'interface jette.
    let mut last_emitted = 0u64;
    let mut last_label = String::new();
    let mut report = move |done: u64, label: &str| {
        let step = (total / 100).max(256 * 1024);
        if done < last_emitted + step && label == last_label && done != total {
            return;
        }
        last_emitted = done;
        last_label = label.to_string();
        let _ = app_for_report.emit(
            "transfer-progress",
            TransferProgressEvent {
                transfer_id: id_for_report.clone(),
                bytes_done: done,
                bytes_total: total,
                label: Some(label.to_string()),
            },
        );
    };

    // Le listing de destination sert à deux choses : savoir ce qui existe déjà,
    // et trouver un nom libre pour « garder les deux ». Lu une fois pour tout
    // le lot, et tenu à jour au fur et à mesure — deux fichiers du même lot
    // peuvent viser le même nom libre.
    let mut taken: Vec<String> = match conflict {
        ConflictPolicy::Overwrite => Vec::new(),
        _ => transfer::list(dest, dest_cwd)
            .await
            .map(|entries| entries.into_iter().map(|e| e.name).collect())
            .unwrap_or_default(),
    };

    let mut progress = transfer::CopyProgress { cancel, report: &mut report, done: 0 };
    for entry in entries {
        let clashes = taken.iter().any(|name| name == &entry.name);
        let dest_name = match (conflict, clashes) {
            (_, false) | (ConflictPolicy::Overwrite, _) => entry.name.clone(),
            (ConflictPolicy::Skip, true) => continue,
            (ConflictPolicy::KeepBoth, true) => transfer::free_name(&taken, &entry.name),
        };
        taken.push(dest_name.clone());
        transfer::copy_entry_as(source, source_cwd, entry, dest, dest_cwd, &dest_name, &mut progress).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pane_mkdir(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::mkdir(&reference, &cwd, &name)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

#[tauri::command]
pub async fn pane_rename(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    old_name: String,
    new_name: String,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::rename(&reference, &cwd, &old_name, &new_name)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

/// Removes every entry in `entries` from `cwd`, then lists `cwd` once — not
/// once per entry, which would turn a bulk delete into an O(n²) round-trip
/// (each SFTP list is a protocol exchange, each Docker-pane list spawns a
/// fresh `sh` exec in the container).
#[tauri::command]
pub async fn pane_remove(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    entries: Vec<Entry>,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    for entry in &entries {
        transfer::remove(&reference, &cwd, entry)
            .await
            .map_err(|e| e.to_string())?;
    }
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

/// Comment lancer un script `sh` du côté du panneau — voir `Pane::exec`.
fn pane_exec(state: &AppState, pane_id: &str) -> Result<PaneExec, String> {
    let panes = state.panes.lock_recover();
    let pane = panes.get(pane_id).ok_or_else(|| "pane inconnu".to_string())?;
    Ok(match &pane.exec {
        Some(exec) => PaneExec::Shell(exec.clone()),
        None => PaneExec::Local,
    })
}

/// Taille récursive d'un dossier — à la demande, jamais pour tout un listing
/// d'office : c'est un `du` complet par dossier, qui sur `/` ou un gros arbre
/// se compte en secondes (voir `termius_core::pane_ops::dir_size`).
#[tauri::command]
pub async fn pane_dir_size(
    state: State<'_, AppState>,
    pane_id: String,
    path: String,
) -> Result<u64, String> {
    let exec = pane_exec(&state, &pane_id)?;
    pane_ops::dir_size(&exec, &path).await.map_err(|e| e.to_string())
}

/// Recherche récursive par nom sous `root`, bornée en profondeur, en nombre
/// de résultats et en durée. Rend des chemins, pas des entrées : ce que
/// l'interface en fait, c'est naviguer jusqu'au dossier qui les contient.
#[tauri::command]
pub async fn pane_find(
    state: State<'_, AppState>,
    pane_id: String,
    root: String,
    pattern: String,
) -> Result<FindOutcome, String> {
    let exec = pane_exec(&state, &pane_id)?;
    pane_ops::find(&exec, &root, &pattern).await.map_err(|e| e.to_string())
}

/// Archive `names` (fichiers et/ou dossiers de `cwd`) dans `cwd`, du côté du
/// panneau — rien ne transite par le réseau. Rend le listing rafraîchi, comme
/// les autres commandes qui modifient le dossier courant.
#[tauri::command]
pub async fn pane_archive(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    names: Vec<String>,
    archive_name: String,
    format: ArchiveFormat,
) -> Result<PaneListed, String> {
    let base = archive_name.trim();
    if base.is_empty() {
        return Err("Indiquer un nom d'archive.".to_string());
    }
    let file_name = pane_ops::archive_file_name(base, format);
    let reference = pane_ref(&state, &pane_id)?;

    // Écraser une archive existante perdrait son contenu sans prévenir — et
    // `zip` ferait pire, il ajouterait à l'archive déjà là plutôt que de la
    // remplacer, produisant un fichier qui mélange deux sauvegardes.
    let before = transfer::list(&reference, &cwd).await.map_err(|e| e.to_string())?;
    if before.iter().any(|e| e.name == file_name) {
        return Err(format!("« {file_name} » existe déjà dans ce dossier."));
    }

    let exec = pane_exec(&state, &pane_id)?;
    pane_ops::archive(&exec, &cwd, &names, &file_name, format)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd).await.map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

/// Extrait une archive du panneau, sur place. `dest_name` vide = extraire dans
/// le dossier courant ; sinon dans un sous-dossier de ce nom, créé au besoin.
#[tauri::command]
pub async fn pane_extract(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
    dest_name: Option<String>,
) -> Result<PaneListed, String> {
    let exec = pane_exec(&state, &pane_id)?;
    pane_ops::extract(&exec, &cwd, &name, dest_name.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let reference = pane_ref(&state, &pane_id)?;
    let entries = transfer::list(&reference, &cwd).await.map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

#[tauri::command]
pub async fn pane_chmod(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
    mode: u32,
) -> Result<PaneListed, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::set_permissions(&reference, &cwd, &name, mode)
        .await
        .map_err(|e| e.to_string())?;
    let entries = transfer::list(&reference, &cwd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PaneListed { cwd, entries })
}

/// Reads a small file's whole content for the quick-edit modal — no local temp
/// file involved. Callers are expected to gate on file size before calling this.
#[tauri::command]
pub async fn read_pane_file(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
) -> Result<String, String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::read_text(&reference, &cwd, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_pane_file(
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let reference = pane_ref(&state, &pane_id)?;
    transfer::write_text(&reference, &cwd, &name, &content)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferProgressEvent {
    transfer_id: String,
    bytes_done: u64,
    bytes_total: u64,
    /// Ce qui est en train de passer — sans lui, une copie de dossier n'est
    /// qu'une barre qui avance sans dire de quoi.
    label: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferDoneEvent {
    transfer_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferErrorEvent {
    transfer_id: String,
    message: String,
}

/// Uploads local OS files (e.g. dropped from the file explorer) into `cwd` on `pane_id`.
/// Returns one transfer id per file immediately; progress/completion is reported via
/// `transfer-progress` / `transfer-done` / `transfer-error` events.
#[tauri::command]
pub async fn upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    cwd: String,
    local_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let reference = pane_ref(&state, &pane_id)?;
    let mut ids = Vec::with_capacity(local_paths.len());

    for local_path in local_paths {
        let transfer_id = Uuid::new_v4().to_string();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        state
            .transfers
            .lock_recover()
            .insert(transfer_id.clone(), cancel_flag.clone());
        ids.push(transfer_id.clone());

        let reference = reference.clone();
        let cwd = cwd.clone();
        let app_handle = app.clone();
        let id_for_task = transfer_id.clone();
        // Même raison que pour `copy_entries` : l'envoi survit à la fermeture
        // de l'onglet, le bail doit lui survivre aussi.
        let lease = pane_lease(&state, &pane_id);

        tokio::spawn(async move {
            let _lease = lease;
            let result = upload_one(
                &reference,
                &cwd,
                &local_path,
                &id_for_task,
                &app_handle,
                &cancel_flag,
            )
            .await;
            match result {
                Ok(()) => {
                    let _ = app_handle.emit(
                        "transfer-done",
                        TransferDoneEvent {
                            transfer_id: id_for_task.clone(),
                        },
                    );
                }
                Err(e) => {
                    let _ = app_handle.emit(
                        "transfer-error",
                        TransferErrorEvent {
                            transfer_id: id_for_task.clone(),
                            message: e.to_string(),
                        },
                    );
                }
            }
            app_handle
                .state::<AppState>()
                .transfers
                .lock_recover()
                .remove(&id_for_task);
        });
    }
    Ok(ids)
}

async fn upload_one(
    dest: &PaneRef,
    dest_cwd: &str,
    local_path: &str,
    transfer_id: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> anyhow::Result<()> {
    let local = std::path::Path::new(local_path);
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| anyhow::anyhow!("chemin invalide"))?;
    match dest {
        PaneRef::Local => {
            let dest_path = termius_core::sftp::join(dest_cwd, &name);
            tokio::fs::copy(local, dest_path).await?;
            Ok(())
        }
        PaneRef::Remote(client) => {
            let remote_path = termius_core::sftp::join(dest_cwd, &name);
            let transfer_id = transfer_id.to_string();
            let app = app.clone();
            let label = name.clone();
            let mut on_progress = move |done, total| {
                let _ = app.emit(
                    "transfer-progress",
                    TransferProgressEvent {
                        transfer_id: transfer_id.clone(),
                        bytes_done: done,
                        bytes_total: total,
                        label: Some(label.clone()),
                    },
                );
            };
            client.upload(local, &remote_path, cancel, &mut on_progress).await
        }
    }
}

#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> Result<(), String> {
    if let Some(flag) = state
        .transfers
        .lock_recover()
        .get(&transfer_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for a real bug: `rename_all = "camelCase"` on an
    /// internally-tagged enum only renames variant names, not struct-variant
    /// field names — `container_id` needs its own explicit `#[serde(rename =
    /// "containerId")]` or the frontend's camelCase JSON fails to
    /// deserialize with `missing field container_id`, exactly what happened
    /// the first time this shipped (before this field had the rename).
    #[test]
    fn pane_source_docker_accepts_camel_case_field_names() {
        let json = r#"{"kind":"docker","hostId":"11111111-1111-1111-1111-111111111111","containerId":"abc123"}"#;
        let source: PaneSource = serde_json::from_str(json).expect("camelCase containerId must deserialize");
        match source {
            PaneSource::Docker { container_id, .. } => assert_eq!(container_id, "abc123"),
            _ => panic!("expected PaneSource::Docker"),
        }
    }

    #[test]
    fn pane_source_k8s_accepts_camel_case_field_names() {
        let json = r#"{"kind":"k8s","hostId":"11111111-1111-1111-1111-111111111111","podName":"api-7d9f8b6c-x2kq9","containerName":"api"}"#;
        let source: PaneSource = serde_json::from_str(json).expect("camelCase podName/containerName must deserialize");
        match source {
            PaneSource::K8s { pod_name, container_name, .. } => {
                assert_eq!(pod_name, "api-7d9f8b6c-x2kq9");
                assert_eq!(container_name.as_deref(), Some("api"));
            }
            _ => panic!("expected PaneSource::K8s"),
        }
    }
}
