//! Reading installed mods off disk.
//!
//! A mod is a folder under `<app config dir>/mods/<id>/` containing a `mod.json`.
//! That location is deliberate: it sits next to `octoshell.db`, so mods survive
//! uninstalling and reinstalling the app, and it needs no elevation to write.
//!
//! This module deliberately does **no** validation and **no** execution. It reads
//! the manifest text and hands it to the frontend, which validates it against the
//! schema and decides what a mod is allowed to contribute. Two reasons: the
//! schema lives with the code that consumes it, and — more importantly — nothing
//! in a mod should ever be run just because it was installed. Installation copies
//! files; it never launches anything.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One manifest as found on disk. `json` is raw, unvalidated text.
#[derive(Serialize)]
pub struct RawMod {
    /// Folder name — the id we expect the manifest to agree with.
    pub dir: String,
    /// Absolute path to the mod's folder, for display and for resolving its files.
    pub path: String,
    /// The manifest's contents, or null when it couldn't be read.
    pub json: Option<String>,
    /// Why it couldn't be read, when `json` is null.
    pub error: Option<String>,
}

/// `<app config dir>/mods`, created on demand.
fn mods_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    let dir = base.join("mods");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The mods folder's absolute path (so the UI can offer "open folder").
#[tauri::command]
pub fn mods_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(mods_dir(&app)?.to_string_lossy().to_string())
}

/// Every installed mod's raw manifest.
///
/// A folder without a readable `mod.json` is still REPORTED, with the error —
/// never skipped. A mod that silently fails to appear is the worst outcome for
/// someone who just installed one and is looking for it.
#[tauri::command]
pub fn mods_list(app: AppHandle) -> Result<Vec<RawMod>, String> {
    let dir = mods_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let manifest = path.join("mod.json");
        let (json, error) = match std::fs::read_to_string(&manifest) {
            Ok(text) => (Some(text), None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                (None, Some("no mod.json in this folder".to_string()))
            }
            Err(e) => (None, Some(format!("could not read mod.json: {e}"))),
        };
        out.push(RawMod {
            dir: dir_name,
            path: path.to_string_lossy().to_string(),
            json,
            error,
        });
    }
    // Stable order so the list doesn't shuffle between reads.
    out.sort_by(|a, b| a.dir.to_lowercase().cmp(&b.dir.to_lowercase()));
    Ok(out)
}
