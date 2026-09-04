//! macOS-only app polish: the menu bar.
//!
//! A Tauri app on macOS gets a default menu whose accelerators fire BEFORE the
//! webview sees the keys. Two of them matter here: without an **Edit** menu,
//! ⌘C/⌘V/⌘X/⌘A do nothing inside a WKWebView — so the input bar could not
//! paste — and the default **Window ▸ Close** binds ⌘W, which OctoShell uses to
//! close a *project*, not the whole app. So the menu is built here by hand:
//! the standard App and Edit menus, and a Window menu without Close.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "OctoShell")
        .about(Some(AboutMetadata::default()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    // No `close_window`: ⌘W belongs to "close project" in the webview.
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &window]).build()
}
