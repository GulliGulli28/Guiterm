//! Adaptive snippet engine commands. The engine's canonical artifact is
//! plain text in a small DSL (see `termius_core::adaptive`'s module docs) —
//! written by hand, generated/extended by AI from an English description,
//! or both interchangeably; either way the exact same parser and
//! deterministic per-platform renderer apply. The LLM is only ever asked to
//! *write DSL text*, never to run anything or to author a shell command
//! directly — its output is parsed and validated by the same strict parser
//! manual input goes through before it's ever shown to the user.
use crate::commands::fleet::execute_and_record;
use crate::state::AppState;
use serde::Deserialize;
use std::collections::HashMap;
use tauri::{AppHandle, State};
use termius_core::adaptive::{self, ExecutionGroup};
use termius_core::model::{HostId, Snippet, SnippetId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::vault;

/// Asks the AI to write (`existing_text` empty) or extend it with `intent`.
/// The response is validated against the same parser manual input goes
/// through — an invalid response surfaces as an error, never gets saved.
#[tauri::command]
pub async fn generate_adaptive_program(existing_text: String, intent: String) -> Result<String, String> {
    adaptive::generate_program(&existing_text, &intent).await.map_err(|e| e.to_string())
}

/// Parses `program_text` and evaluates it against every host in `host_ids`
/// (using each host's last collected facts), grouping hosts by the exact
/// command they'd run. Purely deterministic — no AI call.
#[tauri::command]
pub fn preview_adaptive_program(
    state: State<'_, AppState>,
    host_ids: Vec<HostId>,
    program_text: String,
) -> Result<Vec<ExecutionGroup>, String> {
    let workspace = state.workspace.lock_recover();
    let program = adaptive::parse_program(&program_text)?;
    Ok(adaptive::preview(&workspace, &host_ids, &program))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCommand {
    pub host_ids: Vec<HostId>,
    pub command: String,
}

/// Executes a reviewed (possibly hand-edited) preview: flattens `groups`
/// into a per-host command map and reuses the same fan-out/streaming/
/// history machinery as a classic fleet run (see [`execute_and_record`]) —
/// `intent` is recorded as the run's summary, and the actual per-host
/// commands are kept alongside it so the history can show exactly what ran
/// where.
#[tauri::command]
pub async fn run_adaptive_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    intent: String,
    groups: Vec<GroupCommand>,
) -> Result<(), String> {
    let mut commands = HashMap::new();
    for group in &groups {
        for &host_id in &group.host_ids {
            commands.insert(host_id, group.command.clone());
        }
    }
    if commands.is_empty() {
        return Err("aucun hôte à cibler".to_string());
    }
    let per_host_commands = Some(commands.clone());
    execute_and_record(&app, &state, run_id, commands, intent, per_host_commands).await
}

/// Creates (`snippet_id: None`) or updates an adaptive snippet — `command`
/// is the DSL program text verbatim (may contain `{{variables}}`, filled in
/// the same way as classic snippets before being parsed/previewed/run).
#[tauri::command]
pub fn save_adaptive_snippet(
    state: State<'_, AppState>,
    snippet_id: Option<SnippetId>,
    name: String,
    command: String,
) -> Result<Workspace, String> {
    let mut workspace = state.workspace.lock_recover();
    match snippet_id.and_then(|id| workspace.snippets.iter_mut().find(|s| s.id == id)) {
        Some(snippet) => {
            snippet.name = name;
            snippet.command = command;
            snippet.adaptive = true;
        }
        None => {
            workspace.snippets.push(Snippet {
                id: SnippetId::new_v4(),
                name,
                command,
                tags: Vec::new(),
                adaptive: true,
            });
        }
    }
    store::save(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.clone())
}

#[tauri::command]
pub fn set_anthropic_api_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("la clé API ne peut pas être vide".to_string());
    }
    vault::store_anthropic_api_key(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_anthropic_api_key() -> Result<(), String> {
    vault::delete_anthropic_api_key().map_err(|e| e.to_string())
}

/// Whether an Anthropic API key is configured — never returns the key
/// itself to the frontend, same discipline as host secrets.
#[tauri::command]
pub fn has_anthropic_api_key() -> Result<bool, String> {
    vault::load_anthropic_api_key()
        .map(|k| k.is_some())
        .map_err(|e| e.to_string())
}
