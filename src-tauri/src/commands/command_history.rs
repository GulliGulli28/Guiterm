use termius_core::sync_ext::MutexExt;
use crate::state::AppState;
use tauri::State;
use termius_core::command_history;

const LOCAL_HISTORY_FILE: &str = "local_history.json";
const SSH_HISTORY_FILE: &str = "ssh_history.json";
const SQL_HISTORY_FILE: &str = "sql_history.json";

/// Ghost-text's view of the history: just the commands, oldest first.
///
/// Still a `Vec<String>` now that entries carry a timestamp and a host, and
/// deliberately so — the suggestion engine has no use for either, and keeping
/// its contract unchanged is what let the activity journal be added without
/// touching `ghostText.ts` or its tests at all. The richer entries are read
/// straight from disk by `termius_core::activity`.
#[tauri::command]
pub fn get_local_history(state: State<'_, AppState>) -> Vec<String> {
    command_history::commands(&state.local_history.lock_recover())
}

#[tauri::command]
pub fn append_local_history(state: State<'_, AppState>, command: String) -> Result<(), String> {
    let mut history = state.local_history.lock_recover();
    // No host: the local terminal's "host" is this machine, which the journal
    // renders as "cette machine" rather than storing a label for.
    command_history::record(&mut history, &command, command_history::now_ms(), None);
    command_history::save(LOCAL_HISTORY_FILE, &history).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ssh_history(state: State<'_, AppState>) -> Vec<String> {
    command_history::commands(&state.ssh_history.lock_recover())
}

/// `host` is the *label*, not the id — it comes from the terminal, which has
/// the host in hand, and a label still says something after that host has been
/// deleted, where a dangling uuid would not. `termius_core::activity` resolves
/// it back to an id when it can, purely so the journal's host filter works.
///
/// `Option` because the SSH history predates it and older callers (a window
/// left open across an update) simply omit it.
#[tauri::command]
pub fn append_ssh_history(state: State<'_, AppState>, command: String, host: Option<String>) -> Result<(), String> {
    let mut history = state.ssh_history.lock_recover();
    command_history::record(&mut history, &command, command_history::now_ms(), host);
    command_history::save(SSH_HISTORY_FILE, &history).map_err(|e| e.to_string())
}

/// L'historique des requêtes SQL, la plus récente en dernier.
///
/// Rend les entrées complètes et non de simples chaînes, contrairement aux deux
/// historiques de shell : leur lecteur est le ghost-text, qui n'a que faire de
/// la date ni de la cible, alors qu'un panneau d'historique de requêtes montre
/// précisément « quand » et « sur quelle connexion ».
#[tauri::command]
pub fn get_sql_history(state: State<'_, AppState>) -> Vec<command_history::CommandEntry> {
    state.sql_history.lock_recover().clone()
}

/// `connection` est le **libellé** de la connexion, pas son id — même raison
/// que pour l'historique SSH : un libellé dit encore quelque chose une fois la
/// connexion supprimée, là où un uuid orphelin ne dit plus rien.
#[tauri::command]
pub fn append_sql_history(state: State<'_, AppState>, query: String, connection: Option<String>) -> Result<(), String> {
    // Pas de garde ici sur une requête vide : `command_history::record` la
    // refuse déjà. Une version précédente en ajoutait une, et la retirer n'a
    // fait échouer aucun test — c'est ce qui a montré qu'elle ne servait à
    // rien.
    let mut history = state.sql_history.lock_recover();
    command_history::record(&mut history, &query, command_history::now_ms(), connection);
    command_history::save(SQL_HISTORY_FILE, &history).map_err(|e| e.to_string())
}
