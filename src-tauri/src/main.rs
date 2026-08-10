#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use state::AppState;
use tauri::Manager;

fn main() {
    // Bound to a named variable, not `_`: dropping the guard shuts the
    // background log writer down, so `let _ = ...` here would discard every
    // line the app goes on to emit. Held until `main` returns.
    let _log_guard = termius_core::logging::init();

    let workspace = match termius_core::store::load_resilient() {
        Ok(termius_core::store::LoadOutcome::Loaded(ws)) => ws,
        Ok(termius_core::store::LoadOutcome::Recovered { workspace, backup }) => {
            // Don't silently swallow this: the previous behaviour started with an
            // empty workspace and the first save then destroyed the real file.
            tracing::error!(
                "workspace.json illisible ou corrompu — fichier préservé sous « {} » ; \
                 démarrage avec un espace de travail vide",
                backup.display()
            );
            workspace
        }
        Err(e) => {
            tracing::error!("échec du chargement du workspace : {e} — démarrage à vide");
            termius_core::model::Workspace::default()
        }
    };
    let local_history = termius_core::command_history::load("local_history.json").unwrap_or_default();
    let ssh_history = termius_core::command_history::load("ssh_history.json").unwrap_or_default();
    let fleet_history = termius_core::fleet_history::load().unwrap_or_default();
    let app_state = AppState {
        workspace: std::sync::Mutex::new(workspace),
        local_history: std::sync::Mutex::new(local_history),
        ssh_history: std::sync::Mutex::new(ssh_history),
        fleet_history: std::sync::Mutex::new(fleet_history),
        ..Default::default()
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        // Opens a fetched remote file with whatever the OS associates with it
        // — see `commands::remote_edit`. Separate from the shell plugin,
        // whose own `open` is deprecated in favour of this one.
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main")
                && let Some(icon) = app.default_window_icon() {
                let _ = window.set_icon(icon.clone() as _);
            }
            // Lets `core`'s SSH authentication ask the user for an MFA/OTP
            // code mid-handshake — see `commands::interactive_auth`. Installed
            // here because it needs an `AppHandle` to reach the frontend, which
            // `core` has no way to obtain.
            termius_core::interactive_auth::set_prompter(std::sync::Arc::new(
                commands::interactive_auth::FrontendPrompter::new(app.handle().clone()),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hosts::get_workspace,
            commands::hosts::save_host,
            commands::proxy::test_proxy_command,
            commands::proxy::test_ssm_tunnel,
            commands::aws::list_aws_profiles,
            commands::aws::list_aws_sso_sessions,
            commands::aws::check_aws_identity,
            commands::aws::list_aws_profile_usage,
            commands::aws::reassign_aws_profile,
            commands::aws::discover_aws_instances,
            commands::aws::import_aws_instances,
            commands::aws::discover_aws_databases,
            commands::aws::import_aws_databases,
            commands::aws_sso::save_aws_sso_session,
            commands::aws_sso::aws_sso_login,
            commands::aws_sso::list_aws_sso_accounts,
            commands::aws_sso::save_aws_sso_profiles,
            commands::aws_sso::list_aws_account_names,
            commands::aws_sso::list_aws_sso_status,
            commands::adaptive::preview_rollback,
            commands::drift::check_drift,
            commands::inventory::read_ansible_inventory,
            commands::inventory::import_ansible_hosts,
            commands::cloud_inventory::list_azure_subscriptions,
            commands::cloud_inventory::discover_azure_vms,
            commands::cloud_inventory::import_azure_hosts,
            commands::cloud_inventory::azure_login,
            commands::cloud_inventory::azure_logout,
            commands::cloud_inventory::list_gcp_projects,
            commands::cloud_inventory::discover_gcp_instances,
            commands::cloud_inventory::import_gcp_hosts,
            commands::aws_sso::list_aws_session_alerts,
            commands::aws_sso::delete_aws_profile,
            commands::aws_sso::delete_aws_sso_session,
            commands::hosts::delete_host,
            commands::hosts::save_group,
            commands::hosts::delete_group,
            commands::hosts::add_snippet,
            commands::hosts::update_snippet,
            commands::hosts::delete_snippet,
            commands::hosts::add_forward,
            commands::hosts::delete_forward,
            commands::hosts::add_private_key,
            commands::hosts::delete_private_key,
            commands::hosts::rename_private_key,
            commands::keys::suggest_certificate_path,
            commands::keys::generate_private_key,
            commands::keys::get_public_key,
            commands::keys::deploy_public_key,
            commands::docker::list_docker_containers,
            commands::docker::connect_docker_exec,
            commands::k8s::list_k8s_pods,
            commands::k8s::connect_k8s_exec,
            commands::fleet::run_fleet_command,
            commands::reachability::probe_reachability,
            commands::remote_search::search_remote_files,
            commands::fleet::get_fleet_history,
            commands::facts::collect_facts,
            commands::adaptive::generate_adaptive_program,
            commands::adaptive::preview_adaptive_program,
            commands::adaptive::compose_adaptive_for_local,
            commands::adaptive::compose_adaptive_for_docker,
            commands::adaptive::compose_adaptive_for_k8s,
            commands::adaptive::run_adaptive_plan,
            commands::adaptive::save_adaptive_snippet,
            commands::adaptive::set_anthropic_api_key,
            commands::adaptive::clear_anthropic_api_key,
            commands::adaptive::has_anthropic_api_key,
            commands::rdp_view::connect_rdp_view,
            commands::rdp_view::send_rdp_view_input,
            commands::rdp_view::close_rdp_view,
            commands::rdp_view::push_rdp_view_clipboard_entries,
            commands::rdp_view::push_rdp_view_clipboard_paths,
            commands::hosts::add_custom_icon,
            commands::hosts::delete_custom_icon,
            commands::hosts::read_icon_file,
            commands::hosts::check_host_status,
            commands::export::export_workspace,
            commands::export::import_workspace,
            commands::export::export_host,
            commands::export::import_host_from_file,
            commands::export::export_text,
            commands::export::diagnostics_directory,
            commands::interactive_auth::submit_ssh_auth_prompt,
            commands::interactive_auth::cancel_ssh_auth_prompt,
            commands::terminal::connect_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::open_local_terminal,
            commands::terminal::list_local_shells,
            commands::terminal::write_local_terminal,
            commands::terminal::resize_local_terminal,
            commands::terminal::close_local_terminal,
            commands::activity::list_activity,
            commands::activity::export_activity,
            commands::command_history::get_local_history,
            commands::command_history::append_local_history,
            commands::command_history::get_ssh_history,
            commands::command_history::append_ssh_history,
            commands::sftp::open_pane,
            commands::sftp::close_pane,
            commands::sftp::list_pane,
            commands::sftp::copy_entry,
            commands::sftp::pane_mkdir,
            commands::sftp::pane_rename,
            commands::sftp::pane_remove,
            commands::sftp::pane_chmod,
            commands::sftp::read_pane_file,
            commands::sftp::write_pane_file,
            commands::sftp::upload_paths,
            commands::sftp::cancel_transfer,
            commands::forward::start_forward,
            commands::forward::stop_forward,
            commands::forward::running_forwards,
            commands::known_hosts::list_known_hosts,
            commands::known_hosts::revoke_known_host,
            commands::known_hosts::preview_ssh_config_import,
            commands::known_hosts::import_ssh_config_hosts,
            commands::vault::master_password_status,
            commands::vault::set_master_password,
            commands::vault::unlock_vault,
            commands::vault::lock_vault,
            commands::vault::change_master_password,
            commands::vault::disable_master_password,
            commands::sql::save_sql_connection,
            commands::sql::delete_sql_connection,
            commands::sql::open_sql_session,
            commands::sql::close_sql_session,
            commands::sql::resync_sql_session,
            commands::sql::list_sql_databases,
            commands::sql::switch_sql_database,
            commands::sql::list_sql_schemas,
            commands::sql::list_sql_tables,
            commands::sql::list_sql_columns,
            commands::sql::run_sql_query,
            commands::sql::export_sql_dump,
            commands::redis::open_redis_session,
            commands::redis::close_redis_session,
            commands::redis::scan_redis_keys,
            commands::redis::get_redis_value,
            commands::redis::run_redis_command,
            commands::mongo::open_mongo_session,
            commands::mongo::close_mongo_session,
            commands::mongo::list_mongo_databases,
            commands::mongo::list_mongo_collections,
            commands::mongo::find_mongo_documents,
            commands::remote_edit::open_remote_file_in_editor,
            commands::remote_edit::list_remote_edits,
            commands::remote_edit::sync_remote_edits,
            commands::remote_edit::end_remote_edit,
            commands::remote_edit::discard_remote_edit,
            commands::terminal::start_session_recording,
            commands::terminal::stop_session_recording,
            commands::terminal::recording_session_ids,
            commands::docker::docker_container_logs,
            commands::docker::docker_container_action,
            commands::k8s::k8s_pod_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
