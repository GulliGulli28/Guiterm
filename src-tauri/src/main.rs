#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;
mod util;

use state::AppState;
use tauri::Manager;

fn main() {
    tracing_subscriber::fmt::init();

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
        .manage(app_state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main")
                && let Some(icon) = app.default_window_icon() {
                let _ = window.set_icon(icon.clone() as _);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::hosts::get_workspace,
            commands::hosts::save_host,
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
            commands::keys::generate_private_key,
            commands::keys::get_public_key,
            commands::keys::deploy_public_key,
            commands::docker::list_docker_containers,
            commands::docker::connect_docker_exec,
            commands::fleet::run_fleet_command,
            commands::fleet::get_fleet_history,
            commands::facts::collect_facts,
            commands::adaptive::generate_adaptive_program,
            commands::adaptive::preview_adaptive_program,
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
            commands::terminal::connect_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::open_local_terminal,
            commands::terminal::list_local_shells,
            commands::terminal::write_local_terminal,
            commands::terminal::resize_local_terminal,
            commands::terminal::close_local_terminal,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
