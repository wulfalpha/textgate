#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod documents;
mod markdown;
mod themes;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

fn main() {
    tauri::Builder::default()
        .manage(documents::Documents::default())
        .invoke_handler(tauri::generate_handler![
            themes::theme_state,
            markdown::render_markdown,
            documents::open_document,
            documents::keep_document,
            documents::save_document
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // The dialog plugin adds each chosen file to the fs scope.
            let grant = app.state::<documents::Documents>().granter();
            app.fs_scope().listen(move |event| {
                if let tauri::fs::Event::PathAllowed(path) = event {
                    grant(path);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Textgate");
}
