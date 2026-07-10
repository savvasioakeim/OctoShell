mod acp;
mod agent;
mod ai;
mod approval;
mod docker;
mod jobctl;
mod ollama;
mod pty;
mod service;

use acp::AcpManager;
use agent::AgentManager;
use ai::AiManager;
use approval::ApprovalBridge;
use docker::{SandboxConfig, SandboxManager};
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
        .manage(SandboxManager::default())
        .manage(SandboxConfig::default())
        .manage(AcpManager::default())
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
            // Sweep any orphaned sandbox containers left by a previous run that
            // crashed or hot-reloaded before `sandbox_stop` could run. Best-effort
            // and off-thread — a missing Docker daemon is a no-op.
            tauri::async_runtime::spawn(docker::cleanup_orphans());
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
            pty::health_check,
            ai::ai_chat,
            ai::ai_cancel,
            agent::agent_send,
            agent::agent_cancel,
            approval::approval_respond,
            service::service_start,
            service::service_stop,
            docker::sandbox_exec,
            docker::sandbox_stop,
            docker::set_sandbox_enabled,
            acp::acp_send,
            acp::acp_cancel,
            acp::acp_oneshot,
            ollama::ollama_version,
            ollama::ollama_tags,
            ollama::ollama_pull,
            ollama::ollama_delete,
            ollama::ollama_library,
            ollama::opencode_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while running OctoShell")
        .run(|app, event| {
            // On clean shutdown, promptly tear down any sandbox containers we're
            // still tracking (a crash won't run this — startup cleanup_orphans is
            // the real safety net — but this avoids leaving them for the next
            // launch's sweep).
            if let tauri::RunEvent::Exit = event {
                let mgr = app.state::<SandboxManager>().inner().clone();
                tauri::async_runtime::block_on(mgr.stop_all());
            }
        });
}
