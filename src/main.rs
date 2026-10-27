#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod markdown;
mod themes;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            themes::theme_state,
            markdown::render_markdown
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("failed to run Textgate");
}
