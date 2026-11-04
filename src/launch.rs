use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

pub const HELP: &str = "Textgate — a Markdown editor\n\nUsage: textgate [OPTIONS] [--] [FILE]...\n\n  -h, --help       Show this help\n  -V, --version    Show the version\n  --              Treat every later argument as a filename\n\nOpen UTF-8 files, each in its own tab, or prepare new files (created only\non Save). Relative paths use the caller's working directory. An existing\nTextgate window receives the files as new tabs; a file that is already\nopen is shown. Local file:// URLs are also accepted. Stdin is not supported.\n";

#[derive(Debug, PartialEq)]
pub enum Command {
    ShowHelp,
    ShowVersion,
    /// Files to open, in order; none starts with an Untitled document.
    Launch(Vec<PathBuf>),
}

pub fn parse(args: &[String], cwd: &Path) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Launch(Vec::new()));
    }
    if args.len() == 1 {
        match args[0].as_str() {
            "-h" | "--help" => return Ok(Command::ShowHelp),
            "-V" | "--version" => return Ok(Command::ShowVersion),
            // Older Launch Services versions can pass a process serial number.
            arg if cfg!(target_os = "macos") && arg.starts_with("-psn_") => {
                return Ok(Command::Launch(Vec::new()));
            }
            _ => {}
        }
    }
    // One bad argument rejects the whole command, so nothing half-opens.
    let mut literal = false;
    let mut paths = Vec::new();
    for argument in args {
        if !literal && argument == "--" {
            literal = true;
            continue;
        }
        paths.push(path_argument(argument, literal, cwd)?);
    }
    if paths.is_empty() {
        return Err("Expected a filename after --.".into());
    }
    Ok(Command::Launch(paths))
}

fn path_argument(argument: &str, literal: bool, cwd: &Path) -> Result<PathBuf, String> {
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
    Ok(path)
}

// Finder delivers files as OS URLs rather than command-line arguments.
#[cfg(any(target_os = "macos", test))]
pub fn from_urls(urls: &[tauri::Url]) -> Result<Command, String> {
    urls.iter()
        .map(|url| {
            url.to_file_path()
                .map_err(|_| "Only local files can be opened.".to_owned())
        })
        .collect::<Result<_, _>>()
        .map(Command::Launch)
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
    let requests: Vec<OpenRequest> = match command {
        Ok(Command::Launch(paths)) => paths
            .iter()
            .map(|path| match path.to_str() {
                Some(text) => {
                    // Only native launch arguments/OS file events can grant these
                    // paths. There is no webview command to grant arbitrary access.
                    app.state::<crate::documents::Documents>().granter()(path);
                    OpenRequest::File {
                        path: text.to_owned(),
                        create,
                    }
                }
                None => OpenRequest::Error {
                    message: "The file path is not valid Unicode.".into(),
                },
            })
            .collect(),
        Err(message) => vec![OpenRequest::Error { message }],
        _ => Vec::new(),
    };
    if !requests.is_empty() {
        let queue = app.state::<OpenRequests>();
        for request in requests {
            queue.push(request);
        }
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
                Ok(Command::Launch(vec![base.join(name)]))
            );
        }
        let absolute = base.join("absolute.md");
        assert_eq!(
            parse(&[absolute.to_str().unwrap().into()], Path::new("unused")),
            Ok(Command::Launch(vec![absolute]))
        );
        assert_eq!(
            parse(&args(&["--", "-notes.md"]), &base),
            Ok(Command::Launch(vec![base.join("-notes.md")]))
        );
    }

    #[test]
    fn accepts_local_urls_without_silently_opening_remote_addresses() {
        let path = cwd().join("space and #hash.md");
        let url = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(
            parse(&[url.to_string()], &cwd()),
            Ok(Command::Launch(vec![path]))
        );
        assert!(parse(&args(&["https://example.com/notes.md"]), &cwd()).is_err());
        assert!(parse(&args(&["file://"]), &cwd()).is_err());
    }

    #[test]
    fn handles_help_version_and_rejects_ambiguous_arguments() {
        assert_eq!(parse(&[], &cwd()), Ok(Command::Launch(Vec::new())));
        for flag in ["-h", "--help"] {
            assert_eq!(parse(&args(&[flag]), &cwd()), Ok(Command::ShowHelp));
        }
        for flag in ["-V", "--version"] {
            assert_eq!(parse(&args(&[flag]), &cwd()), Ok(Command::ShowVersion));
        }
        for values in [
            &["--"][..],
            &["a.md", "--wat"],
            &["a.md", "https://example.com/b.md"],
            &[""],
            &["--wat"],
            &["--help", "a.md"],
            &["-"],
        ] {
            assert!(parse(&args(values), &cwd()).is_err(), "{values:?}");
        }
    }

    #[test]
    fn opens_several_files_in_order_and_dash_dash_covers_every_later_argument() {
        let base = cwd();
        assert_eq!(
            parse(&args(&["a.md", "b.md", "a.md"]), &base),
            Ok(Command::Launch(vec![
                base.join("a.md"),
                base.join("b.md"),
                base.join("a.md")
            ]))
        );
        assert_eq!(
            parse(&args(&["a.md", "--", "-b.md", "--"]), &base),
            Ok(Command::Launch(vec![
                base.join("a.md"),
                base.join("-b.md"),
                base.join("--")
            ]))
        );
    }

    #[test]
    fn os_open_events_accept_several_files_and_keep_url_decoding() {
        let path = cwd().join("日本語 and space.md");
        let url = tauri::Url::from_file_path(&path).unwrap();
        assert_eq!(from_urls(&[]), Ok(Command::Launch(Vec::new())));
        assert_eq!(
            from_urls(std::slice::from_ref(&url)),
            Ok(Command::Launch(vec![path.clone()]))
        );
        let other = cwd().join("b.md");
        assert_eq!(
            from_urls(&[url.clone(), tauri::Url::from_file_path(&other).unwrap()]),
            Ok(Command::Launch(vec![path, other]))
        );
        assert!(from_urls(&[url, tauri::Url::parse("https://example.com").unwrap()]).is_err());
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
