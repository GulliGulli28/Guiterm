#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;
mod util;

use state::AppState;
use tauri::Manager;

fn main() {
    tracing_subscriber::fmt::init();

    let workspace = termius_core::store::load().unwrap_or_default();
    let local_history = termius_core::command_history::load("local_history.json").unwrap_or_default();
    let ssh_history = termius_core::command_history::load("ssh_history.json").unwrap_or_default();
    let app_state = AppState {
        workspace: std::sync::Mutex::new(workspace),
        local_history: std::sync::Mutex::new(local_history),
        ssh_history: std::sync::Mutex::new(ssh_history),
        ..Default::default()
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
