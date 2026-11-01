use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

pub const HELP: &str = "Textgate — a Markdown editor\n\nUsage: textgate [OPTIONS] [--] [FILE]\n\n  -h, --help       Show this help\n  -V, --version    Show the version\n  --              Treat the next argument as a filename\n\nOpen one UTF-8 file, or prepare a new file (created only on Save).\nRelative paths use the caller's working directory. An existing Textgate\nwindow receives the file and asks before discarding unsaved changes.\nLocal file:// URLs are also accepted. Multiple files and stdin are not supported.\n";

#[derive(Debug, PartialEq)]
pub enum Command {
    ShowHelp,
    ShowVersion,
    Launch(Option<PathBuf>),
}

pub fn parse(args: &[String], cwd: &Path) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Launch(None));
    }
    if args.len() == 1 {
        match args[0].as_str() {
            "-h" | "--help" => return Ok(Command::ShowHelp),
            "-V" | "--version" => return Ok(Command::ShowVersion),
            // Older Launch Services versions can pass a process serial number.
            arg if cfg!(target_os = "macos") && arg.starts_with("-psn_") => {
                return Ok(Command::Launch(None));
            }
            _ => {}
        }
    }
    let literal = args[0] == "--";
    let paths = if literal { &args[1..] } else { args };
    if paths.len() != 1 {
        return Err("Textgate opens one file at a time. Usage: textgate [--] FILE".into());
    }
    let argument = &paths[0];
    if argument.is_empty() {
        return Err("The file path must not be empty.".into());
    }
    if !literal && argument.starts_with('-') {
        return Err(format!(
            "Unknown option {argument}. Use -- before a filename starting with '-'."
        ));
    }
    if argument == "file://" {
        return Err("Expected a local file:// URL with a path.".into());
    }
    let path = if argument.starts_with("file://") {
        tauri::Url::parse(argument)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or("Expected a local file:// URL.")?
    } else if argument.contains("://") {
        return Err("Only local files and file:// URLs can be opened.".into());
    } else {
        let path = PathBuf::from(argument);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    if !path.is_absolute() {
        return Err("Could not resolve the caller's working directory.".into());
    }
    if path.to_str().is_none() {
        return Err("The file path is not valid Unicode.".into());
    }
    // Do not lexically collapse .. across symlinks: the filesystem must resolve it.
    Ok(Command::Launch(Some(path)))
}

// Finder delivers files as OS URLs rather than command-line arguments.
#[cfg(any(target_os = "macos", test))]
pub fn from_urls(urls: &[tauri::Url]) -> Result<Command, String> {
    match urls {
        [] => Ok(Command::Launch(None)),
        [url] => url
            .to_file_path()
            .map(|path| Command::Launch(Some(path)))
            .map_err(|_| "Only local files can be opened.".into()),
        _ => Err("Textgate opens one file at a time. Select a single file in Finder.".into()),
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenRequest {
    File { path: String, create: bool },
    Error { message: String },
}

#[derive(Default)]
pub struct OpenRequests(Mutex<VecDeque<OpenRequest>>);
impl OpenRequests {
    fn push(&self, request: OpenRequest) {
        let mut pending = self.0.lock().unwrap();
        if pending.back() != Some(&request) {
            pending.push_back(request);
        }
    }
    fn take(&self) -> Vec<OpenRequest> {
        self.0.lock().unwrap().drain(..).collect()
    }
}

pub fn focus(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn receive(app: &tauri::AppHandle, command: Result<Command, String>, create: bool) {
    let request = match command {
        Ok(Command::Launch(Some(path))) => match path.to_str() {
            Some(text) => {
                // Only native launch arguments/OS file events can grant these
                // paths. There is no webview command to grant arbitrary access.
                app.state::<crate::documents::Documents>().granter()(&path);
                Some(OpenRequest::File {
                    path: text.to_owned(),
                    create,
                })
            }
            None => Some(OpenRequest::Error {
                message: "The file path is not valid Unicode.".into(),
            }),
        },
        Err(message) => Some(OpenRequest::Error { message }),
        _ => None,
    };
    if let Some(request) = request {
        app.state::<OpenRequests>().push(request);
        // The persistent queue also covers events before the webview is ready.
        let _ = app.emit_to("main", "open-request", ());
    }
    focus(app);
}

#[tauri::command]
pub fn take_open_requests(requests: tauri::State<'_, OpenRequests>) -> Vec<OpenRequest> {
    requests.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cwd() -> PathBuf {
        std::env::temp_dir().join("textgate launch tests")
    }
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn resolves_paths_against_the_sending_process_directory() {
        let base = cwd();
        for name in [
            "notes.md",
            "notes with spaces.md",
            "日本語.md",
            "folder/../notes.md",
        ] {
            assert_eq!(
                parse(&args(&[name]), &base),
                Ok(Command::Launch(Some(base.join(name))))
            );
        }
        let absolute = base.join("absolute.md");
        assert_eq!(
            parse(&[absolute.to_str().unwrap().into()], Path::new("unused")),
            Ok(Command::Launch(Some(absolute)))
        );
        assert_eq!(
            parse(&args(&["--", "-notes.md"]), &base),
            Ok(Command::Launch(Some(base.join("-notes.md"))))
        );
    }

    #[test]
    fn accepts_local_urls_without_silently_opening_remote_addresses() {
        let path = cwd().join("space and #hash.md");
        let url = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(
            parse(&[url.to_string()], &cwd()),
            Ok(Command::Launch(Some(path)))
        );
        assert!(parse(&args(&["https://example.com/notes.md"]), &cwd()).is_err());
        assert!(parse(&args(&["file://"]), &cwd()).is_err());
    }

    #[test]
    fn handles_help_version_and_rejects_ambiguous_arguments() {
        assert_eq!(parse(&[], &cwd()), Ok(Command::Launch(None)));
        for flag in ["-h", "--help"] {
            assert_eq!(parse(&args(&[flag]), &cwd()), Ok(Command::ShowHelp));
        }
        for flag in ["-V", "--version"] {
            assert_eq!(parse(&args(&[flag]), &cwd()), Ok(Command::ShowVersion));
        }
        for values in [
            &["a.md", "b.md"][..],
            &["--"],
            &[""],
            &["--wat"],
            &["--help", "a.md"],
            &["-"],
        ] {
            assert!(parse(&args(values), &cwd()).is_err(), "{values:?}");
        }
    }

    #[test]
    fn os_open_events_reject_multiple_files_and_keep_url_decoding() {
        let path = cwd().join("日本語 and space.md");
        let url = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(from_urls(&[]), Ok(Command::Launch(None)));
        assert_eq!(
            from_urls(std::slice::from_ref(&url)),
            Ok(Command::Launch(Some(path)))
        );
        assert!(from_urls(&[url.clone(), url]).is_err());
        assert!(from_urls(&[tauri::Url::parse("https://example.com").unwrap()]).is_err());
    }

    #[test]
    fn queues_startup_requests_once_and_preserves_arrival_order() {
        let requests = OpenRequests::default();
        let a = OpenRequest::File {
            path: "a.md".into(),
            create: true,
        };
        let b = OpenRequest::File {
            path: "b.md".into(),
            create: false,
        };
        requests.push(a.clone());
        requests.push(a.clone());
        requests.push(b.clone());
        assert_eq!(requests.take(), vec![a, b]);
        assert!(requests.take().is_empty());
    }
}
