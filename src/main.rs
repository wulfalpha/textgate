#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod documents;
mod launch;
mod markdown;
mod themes;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

fn main() {
    // Release Windows GUI binaries have no console by default. Reuse the
    // caller's console for --help/--version/errors without creating a new one.
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(
            windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
    let args: Result<Vec<String>, _> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect();
    let initial = args
        .map_err(|_| "Arguments must be valid Unicode.".to_owned())
        .and_then(|args| {
            let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
            launch::parse(&args, &cwd)
        });
    let initial = match initial {
        Ok(launch::Command::ShowHelp) => {
            print!("{}", launch::HELP);
            return;
        }
        Ok(launch::Command::ShowVersion) => {
            println!("Textgate {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Ok(command) => command,
        Err(error) => {
            eprintln!("Textgate: {error}\nUse textgate --help for usage.");
            std::process::exit(2);
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            launch::receive(
                app,
                launch::parse(
                    &args.into_iter().skip(1).collect::<Vec<_>>(),
                    std::path::Path::new(&cwd),
                ),
                true,
            );
        }))
        .manage(launch::OpenRequests::default())
        .manage(documents::Documents::default())
        .invoke_handler(tauri::generate_handler![
            themes::theme_state,
            markdown::render_markdown,
            documents::open_document,
            documents::keep_document,
            documents::save_document,
            launch::take_open_requests
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            // The dialog plugin adds each chosen file to the fs scope.
            let grant = app.state::<documents::Documents>().granter();
            app.fs_scope().listen(move |event| {
                if let tauri::fs::Event::PathAllowed(path) = event {
                    grant(path);
                }
            });
            launch::receive(app.handle(), Ok(initial), true);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Textgate")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    let command = launch::from_urls(&urls);
                    launch::receive(_app, command, false);
                }
                tauri::RunEvent::Reopen { .. } => launch::focus(_app),
                _ => {}
            }
        });
}
