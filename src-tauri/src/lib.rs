mod acp;
mod agent;
mod ai;
mod approval;
mod docker;
mod embed;
mod jobctl;
mod memory;
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
    vec![
        Migration {
            version: 1,
            description: "create blocks table",
            sql: "CREATE TABLE IF NOT EXISTS blocks (\
                session_id TEXT PRIMARY KEY, \
                data TEXT NOT NULL, \
                updated_at INTEGER NOT NULL);",
            kind: MigrationKind::Up,
        },
        // Workspace memory: what happened, across sessions. Deliberately separate
        // from `blocks` — that table is the live conversation and is DELETED when a
        // project closes (see deleteBlocksDb), which is exactly the history we need
        // to keep. `memory` holds the durable facts; `memory_chunk` holds the
        // embedded slices we actually match against (small-to-big retrieval).
        Migration {
            version: 2,
            description: "create workspace memory tables",
            sql: "CREATE TABLE IF NOT EXISTS memory (\
                    id TEXT PRIMARY KEY, \
                    kind TEXT NOT NULL, \
                    project TEXT NOT NULL, \
                    branch TEXT, \
                    cwd TEXT, \
                    text TEXT NOT NULL, \
                    meta TEXT, \
                    created_at INTEGER NOT NULL); \
                  CREATE INDEX IF NOT EXISTS memory_created ON memory(created_at DESC); \
                  CREATE INDEX IF NOT EXISTS memory_project ON memory(project); \
                  CREATE TABLE IF NOT EXISTS memory_chunk (\
                    id TEXT PRIMARY KEY, \
                    memory_id TEXT NOT NULL, \
                    ord INTEGER NOT NULL, \
                    text TEXT NOT NULL, \
                    embedding BLOB, \
                    model TEXT, \
                    dim INTEGER); \
                  CREATE INDEX IF NOT EXISTS chunk_memory ON memory_chunk(memory_id); \
                  CREATE INDEX IF NOT EXISTS chunk_pending ON memory_chunk(embedding) \
                    WHERE embedding IS NULL; \
                  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts \
                    USING fts5(text, chunk_id UNINDEXED);",
            kind: MigrationKind::Up,
        },
    ]
}

/// Write a UTF-8 text file at `path`, creating parent dirs as needed. Used by
/// Strategy Mode's "Save Plan → .md export" (the frontend picks the path via the
/// save dialog). Returns the path back on success.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<String, String> {
    use std::path::Path;
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Persist a file dropped onto the window (pasted image, screenshot, …) into a
/// scratch dir and return its path.
///
/// The window runs with `dragDropEnabled: false` so the sidebar keeps working
/// HTML5 drag & drop for reordering; that also means a drop reaches us as bytes
/// through the browser File API, never as a filesystem path. Agents need a real
/// path to open, so we materialise one here. `data` is base64 (the only shape
/// that survives the IPC bridge without a per-byte JSON array).
#[tauri::command]
fn save_dropped_file(name: String, data: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::time::{SystemTime, UNIX_EPOCH};

    let bytes = STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;

    // Keep only the basename's safe characters: a dropped name is untrusted and
    // must never be able to escape the scratch dir.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("drop");
    let safe: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe = if safe.trim_matches('_').is_empty() { "drop".to_string() } else { safe };

    let dir = std::env::temp_dir().join("octoshell-drops");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{stamp}-{safe}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
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
        .manage(memory::MemoryIndex::default())
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
            pty::kill_foreground,
            pty::run_capture,
            pty::shell_complete,
            pty::open_editor,
            pty::open_in_file_manager,
            pty::health_check,
            ai::ai_chat,
            ai::ai_cancel,
            ai::list_mcp_servers,
            agent::agent_send,
            agent::agent_cancel,
            approval::approval_respond,
            service::service_start,
            service::service_stop,
            service::list_ports,
            service::kill_port,
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
            memory::memory_chunk,
            memory::memory_embed,
            memory::memory_index_put,
            memory::memory_index_remove,
            memory::memory_index_clear,
            memory::memory_stats,
            memory::memory_search,
            write_text_file,
            save_dropped_file,
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
