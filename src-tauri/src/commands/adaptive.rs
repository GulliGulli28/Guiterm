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
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, State};
use termius_core::adaptive::{self, ComposeResult, ExecutionGroup};
use termius_core::aws_inventory;
use termius_core::fleet::FleetTarget;
use termius_core::model::{HostFacts, HostId, Snippet, SnippetId, Workspace};
use termius_core::store;
use termius_core::sync_ext::MutexExt;
use termius_core::{docker, facts, k8s, local_shell};
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

/// What undoing a past run would do, before anything is undone.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPlan {
    /// The inverse program in DSL form, shown so the user reads *operations*
    /// rather than a wall of shell — and can tell at a glance that "annuler"
    /// means what they think.
    pub program_text: String,
    /// The same grouping a forward run gets, so the same review UI applies.
    pub groups: Vec<ExecutionGroup>,
    /// Everything this rollback will **not** put back, each with its reason.
    /// Never hidden: a partial rollback presented as a complete one is worse
    /// than no rollback at all.
    pub unreversed: Vec<UnreversedOperation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreversedOperation {
    pub function: String,
    pub reason: String,
}

/// Builds the rollback of a recorded run, without running anything.
///
/// Fails rather than guesses when the run carries no DSL program: a classic
/// free-command run, or one recorded before rollback existed. Inferring the
/// operations back from the rendered shell is the one thing this must not do —
/// see [`termius_core::fleet_history::FleetRun::program_text`].
///
/// Evaluated against each host's *current* facts, not the run's: the rollback
/// runs now, and a host that changed platform since should get the command its
/// platform speaks today.
#[tauri::command]
pub fn preview_rollback(state: State<'_, AppState>, run_id: uuid::Uuid) -> Result<RollbackPlan, String> {
    let (program_text, targets, previous_hostnames) = {
        let history = state.fleet_history.lock_recover();
        let run = history
            .iter()
            .find(|run| run.id == run_id)
            .ok_or_else(|| "ce run n'est plus dans l'historique".to_string())?;
        let program_text = run.program_text.clone().ok_or_else(|| {
            "ce run n'a pas été enregistré avec son programme : impossible de savoir \
             quelles opérations il a effectuées, donc de les annuler"
                .to_string()
        })?;
        (program_text, run.targets.clone(), run.previous_hostnames.clone())
    };

    // Rollback is SSH-only for the same reason the forward adaptive run is
    // (see `preview_adaptive_program`): the per-host evaluation needs
    // persisted facts, which only SSH hosts carry.
    let host_ids: Vec<HostId> = targets
        .iter()
        .filter_map(|target| match target {
            FleetTarget::Ssh { host_id } => Some(*host_id),
            _ => None,
        })
        .collect();

    let program = adaptive::parse_program(&program_text)?;
    // One hostname for the whole run: `set-hostname` on a fleet sets the same
    // name everywhere, so per-host restoration would be restoring a name the
    // program never set. Any captured name will do, and none means the
    // operation reports itself as irreversible.
    let previous_hostname = previous_hostnames
        .as_ref()
        .and_then(|names| host_ids.iter().find_map(|id| names.get(id)))
        .cloned();
    let inverted = adaptive::invert_program(&program, previous_hostname.as_deref());

    let workspace = state.workspace.lock_recover();
    Ok(RollbackPlan {
        program_text: adaptive::render_program(&inverted.program),
        groups: adaptive::preview(&workspace, &host_ids, &inverted.program),
        unreversed: inverted
            .unreversed
            .into_iter()
            .map(|u| UnreversedOperation { function: u.function, reason: u.reason.to_string() })
            .collect(),
    })
}

/// Translates `program_text` for a **local terminal** tab's shell — a
/// native Windows shell (PowerShell/cmd) needs no probing at all, the
/// platform is simply whatever OS Guiterm itself runs on; anything else
/// (a real POSIX shell, WSL) is probed for real via a one-off local process
/// (`facts::probe_local`), the same mechanism SSH/Docker exec use, just run
/// locally instead of over a connection. Single target, so this returns a
/// [`ComposeResult`] directly rather than [`preview_adaptive_program`]'s
/// per-host grouping.
#[tauri::command]
pub async fn compose_adaptive_for_local(program_text: String, shell: Option<String>) -> Result<ComposeResult, String> {
    let resolved_shell = local_shell::resolve_local_shell(shell.as_deref());
    let host_facts = if local_shell::is_windows_native_shell(&resolved_shell) {
        Some(HostFacts { os_id: Some("windows".to_string()), os_name: Some("Windows".to_string()), ..Default::default() })
    } else {
        let shell_for_probe = resolved_shell.clone();
        tokio::task::spawn_blocking(move || facts::probe_local(&shell_for_probe))
            .await
            .map_err(|e| e.to_string())?
    };
    let program = adaptive::parse_program(&program_text)?;
    let platform_key = host_facts.as_ref().and_then(|f| f.os_id.clone()).unwrap_or_else(|| "unknown".to_string());
    // No tags and no profile: a local terminal has no `Host` to draw them from
    // — only `target name` (matched against the shell name) is meaningful here.
    let ctx = adaptive::HostContext {
        facts: host_facts.as_ref(),
        name: &resolved_shell,
        tags: &[],
        profile: None,
    };
    Ok(adaptive::compose_for_host(&program, &platform_key, ctx))
}

/// Translates `program_text` for a **Docker exec** terminal's container —
/// probed fresh via a one-off `exec` on every call, never cached: unlike an
/// SSH `Host`, a `dockerExec` `Host` isn't tied to one container (see
/// `HostKind::DockerExec`'s doc comment), so there's nowhere to persist a
/// single `lastFacts` snapshot without conflating different containers.
#[tauri::command]
pub async fn compose_adaptive_for_docker(
    state: State<'_, AppState>,
    program_text: String,
    host_id: HostId,
    container_id: String,
) -> Result<ComposeResult, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = workspace.host(host_id).ok_or_else(|| "hôte inconnu".to_string())?;
    let docker_client = docker::connect_for_host(&workspace, host).await.map_err(|e| e.to_string())?;
    let host_facts = docker::probe_container_facts(&docker_client, &container_id).await;
    let program = adaptive::parse_program(&program_text)?;
    let platform_key = host_facts.as_ref().and_then(|f| f.os_id.clone()).unwrap_or_else(|| "unknown".to_string());
    // `name` mirrors the tab label convention (`${host.label} : ${containerId}`,
    // see `App.tsx`'s `openTab`) so `target name` reads the same way a user
    // already sees the target named elsewhere in the UI.
    let name = format!("{} : {container_id}", host.label);
    // The profile is the *host's*, not the container's: it is how the machine
    // running Docker is reached, which is exactly the cut `target profile:` is
    // for.
    let ctx = adaptive::HostContext {
        facts: host_facts.as_ref(),
        name: &name,
        tags: &host.tags,
        profile: host.proxy_command.as_deref().and_then(aws_inventory::profile_in_command),
    };
    Ok(adaptive::compose_for_host(&program, &platform_key, ctx))
}

/// Translates `program_text` for a **K8s exec** terminal's pod — same
/// "probed fresh, never cached" reasoning as [`compose_adaptive_for_docker`]:
/// a `k8sExec` `Host` isn't tied to one pod either.
#[tauri::command]
pub async fn compose_adaptive_for_k8s(
    state: State<'_, AppState>,
    program_text: String,
    host_id: HostId,
    pod_name: String,
    container_name: Option<String>,
) -> Result<ComposeResult, String> {
    let workspace = state.workspace.lock_recover().clone();
    let host = workspace.host(host_id).ok_or_else(|| "hôte inconnu".to_string())?;
    let client = k8s::connect(&host.address).await.map_err(|e| e.to_string())?;
    let host_facts = k8s::probe_pod_facts(&client, &host.username, &pod_name, container_name.as_deref()).await;
    let program = adaptive::parse_program(&program_text)?;
    let platform_key = host_facts.as_ref().and_then(|f| f.os_id.clone()).unwrap_or_else(|| "unknown".to_string());
    // `name` mirrors the tab label convention (`${host.label} : ${podName}`,
    // see `App.tsx`'s `openTab`), same spirit as the Docker arm above.
    let name = format!("{} : {pod_name}", host.label);
    let ctx = adaptive::HostContext {
        facts: host_facts.as_ref(),
        name: &name,
        tags: &host.tags,
        profile: host.proxy_command.as_deref().and_then(aws_inventory::profile_in_command),
    };
    Ok(adaptive::compose_for_host(&program, &platform_key, ctx))
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
    // `program_text` is the DSL source the preview came from, recorded with the
    // run so it can be undone later — the commands in `groups` are rendered
    // shell, and shell can't be inverted.
    program_text: Option<String>,
) -> Result<(), String> {
    let mut per_host: HashMap<HostId, String> = HashMap::new();
    for group in &groups {
        for &host_id in &group.host_ids {
            per_host.insert(host_id, group.command.clone());
        }
    }
    if per_host.is_empty() {
        return Err("aucun hôte à cibler".to_string());
    }
    // Adaptive runs are SSH-only (see `preview_adaptive_program`), so every
    // target here wraps an SSH host id — `per_host_commands` stays keyed by
    // plain `HostId` (unaffected by `FleetTarget` existing) since that's the
    // shape `FleetRun`/the frontend's per-platform breakdown already expect.
    let commands: HashMap<FleetTarget, String> =
        per_host.iter().map(|(&host_id, cmd)| (FleetTarget::Ssh { host_id }, cmd.clone())).collect();
    execute_and_record(&app, &state, run_id, commands, intent, Some(per_host), program_text).await
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
