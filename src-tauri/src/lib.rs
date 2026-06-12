mod agent;
mod ai;
mod approval;
mod pty;

use agent::AgentManager;
use approval::ApprovalBridge;
use pty::{CompletionEngine, PtyManager};
use tauri::Manager;

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Shared, thread-safe registries of all open PTY + agent sessions.
        .manage(PtyManager::default())
        .manage(AgentManager::default())
        .manage(CompletionEngine::default())
        .manage(ApprovalBridge::default())
        .setup(|app| {
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
            ai::ai_chat,
            agent::agent_send,
            agent::agent_cancel,
            approval::approval_respond,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OctoShell");
}
