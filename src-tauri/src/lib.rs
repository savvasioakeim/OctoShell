mod agent;
mod ai;
mod approval;
mod jobctl;
mod pty;
mod service;

use agent::AgentManager;
use ai::AiManager;
use approval::ApprovalBridge;
use pty::{CompletionEngine, PtyManager};
use service::ServiceManager;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// SQLite schema for local block history (one JSON blob per session) — async +
/// no localStorage size cap. Prefs stay in localStorage (small).
fn db_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create blocks table",
        sql: "CREATE TABLE IF NOT EXISTS blocks (\
                session_id TEXT PRIMARY KEY, \
                data TEXT NOT NULL, \
                updated_at INTEGER NOT NULL);",
        kind: MigrationKind::Up,
    }]
}

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:octoshell.db", db_migrations())
                .build(),
        )
        // Shared, thread-safe registries of all open PTY + agent sessions.
        .manage(PtyManager::default())
        .manage(AgentManager::default())
        .manage(AiManager::default())
        .manage(CompletionEngine::default())
        .manage(ApprovalBridge::default())
        .manage(ServiceManager::default())
        .setup(|app| {
            // Create the kill-on-close Job Object FIRST, before anything is
            // spawned, so every shell/agent we launch can be tied to our lifetime
            // and can't be orphaned on a crash or hot-reload.
            jobctl::init();
            // Pre-warm the Tab-completion runspace so the first Tab is instant.
            let engine = app.state::<CompletionEngine>().inner().clone();
            std::thread::spawn(move || engine.warm());
            // Start the per-tool approval bridge (sidecar + localhost listener).
            app.state::<ApprovalBridge>().start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::open_new_tab,
            pty::write_to_terminal,
            pty::resize_terminal,
            pty::close_tab,
            pty::run_capture,
            pty::shell_complete,
            pty::open_editor,
            pty::open_in_file_manager,
            ai::ai_chat,
            ai::ai_cancel,
            agent::agent_send,
            agent::agent_cancel,
            approval::approval_respond,
            service::service_start,
            service::service_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OctoShell");
}
