use crate::state::AppState;
use tauri::State;
use termius_core::command_history;

const LOCAL_HISTORY_FILE: &str = "local_history.json";
const SSH_HISTORY_FILE: &str = "ssh_history.json";

#[tauri::command]
pub fn get_local_history(state: State<'_, AppState>) -> Vec<String> {
    state.local_history.lock().expect("lock poisoned").clone()
}

#[tauri::command]
pub fn append_local_history(state: State<'_, AppState>, command: String) -> Result<(), String> {
    let mut history = state.local_history.lock().expect("lock poisoned");
    command_history::record(&mut history, &command);
    command_history::save(LOCAL_HISTORY_FILE, &history).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ssh_history(state: State<'_, AppState>) -> Vec<String> {
    state.ssh_history.lock().expect("lock poisoned").clone()
}

#[tauri::command]
pub fn append_ssh_history(state: State<'_, AppState>, command: String) -> Result<(), String> {
    let mut history = state.ssh_history.lock().expect("lock poisoned");
    command_history::record(&mut history, &command);
    command_history::save(SSH_HISTORY_FILE, &history).map_err(|e| e.to_string())
}
