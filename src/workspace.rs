//! The workspace: one folder the user chose, whose Markdown and text files the
//! file browser lists and opens. Choosing it grants that folder and nothing
//! outside it; every path is checked after resolving symbolic links, so a link
//! inside the workspace cannot reach elsewhere.

use crate::documents::{DocumentId, Documents};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs, io,
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

/// The chosen folder as the user named it, and where it really is.
#[derive(Clone, Debug)]
pub struct Root {
    given: PathBuf,
    real: PathBuf,
}

impl Root {
    pub(crate) fn link_base(&self) -> &Path {
        &self.given
    }

    pub(crate) fn watch_path(&self) -> &Path {
        &self.real
    }

    pub fn new(given: &Path) -> io::Result<Self> {
        if !fs::metadata(given)?.is_dir() {
            return Err(io::Error::other("Choose a folder."));
        }
        Ok(Self {
            given: given.to_path_buf(),
            real: fs::canonicalize(given)?,
        })
    }

    // Inside the root once symbolic links are resolved. A file that does not
    // exist yet is placed by its folder. Paths with `..` are refused outright.
    pub fn contains(&self, path: &Path) -> bool {
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return false;
        }
        let real = fs::canonicalize(path).or_else(|_| {
            let (parent, name) = (path.parent(), path.file_name());
            match parent.zip(name) {
                Some((parent, name)) => fs::canonicalize(parent).map(|dir| dir.join(name)),
                None => Err(io::ErrorKind::NotFound.into()),
            }
        });
        real.is_ok_and(|real| real.starts_with(&self.real))
    }

    // An entry inside the workspace that may be renamed or trashed: it exists
    // (a broken link counts) and is not the workspace folder itself.
    fn entry(&self, path: &Path) -> Result<(), String> {
        if !self.contains(path) || fs::symlink_metadata(path).is_err() {
            return Err("That item is not in the open folder any more. Refresh the list.".into());
        }
        if fs::canonicalize(path).is_ok_and(|real| real == self.real) {
            return Err("The open folder itself cannot be changed here.".into());
        }
        Ok(())
    }
}

pub(crate) fn relative_label(root: &Root, path: &Path) -> String {
    let real = fs::canonicalize(path)
        .or_else(|_| {
            path.parent()
                .zip(path.file_name())
                .ok_or_else(|| io::Error::other("No parent."))
                .and_then(|(parent, name)| fs::canonicalize(parent).map(|p| p.join(name)))
        })
        .ok();
    path.strip_prefix(root.link_base())
        .ok()
        .or_else(|| path.strip_prefix(root.watch_path()).ok())
        .or_else(|| {
            real.as_deref()
                .and_then(|p| p.strip_prefix(root.watch_path()).ok())
        })
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Workspace {
    path: String,
    name: String,
}

impl From<&Root> for Workspace {
    fn from(root: &Root) -> Self {
        Self {
            path: root.given.to_string_lossy().into_owned(),
            name: root
                .given
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.given.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    folder: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Listing {
    entries: Vec<Entry>,
    /// Entries left out past the limit.
    omitted: usize,
}

const LIMIT: usize = 1000;
pub(crate) const EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

fn shown(name: &str) -> bool {
    !name.starts_with('.') && name != "node_modules"
}

// Natural order, ignoring case: "note 2" before "note 10".
fn natural(a: &str, b: &str) -> Ordering {
    fn chunks(text: &str) -> Vec<(bool, String)> {
        let mut parts: Vec<(bool, String)> = Vec::new();
        for c in text.chars() {
            let digit = c.is_ascii_digit();
            match parts.last_mut() {
                Some((kind, part)) if *kind == digit => part.push(c),
                _ => parts.push((digit, c.to_string())),
            }
        }
        parts
    }
    let (left, right) = (chunks(a), chunks(b));
    for ((ld, l), (rd, r)) in left.iter().zip(&right) {
        let order = if *ld && *rd {
            let (l, r) = (l.trim_start_matches('0'), r.trim_start_matches('0'));
            l.len().cmp(&r.len()).then_with(|| l.cmp(r))
        } else {
            l.to_lowercase().cmp(&r.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len()).then_with(|| a.cmp(b))
}

// One folder's entries: folders, then Markdown and text files, each in natural
// order. Hidden entries, other files, broken links and links leading outside
// the workspace are left out.
fn list(root: &Root, folder: &Path, limit: usize) -> io::Result<Listing> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        let (Some(name), Some(text)) =
            (entry.file_name().to_str().map(str::to_owned), path.to_str())
        else {
            continue;
        };
        if !shown(&name) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let wanted = meta.is_dir()
            || (meta.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                    }));
        if !wanted || (entry.file_type()?.is_symlink() && !root.contains(&path)) {
            continue;
        }
        entries.push(Entry {
            path: text.to_owned(),
            name,
            folder: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.folder
            .cmp(&a.folder)
            .then_with(|| natural(&a.name, &b.name))
    });
    let omitted = entries.len().saturating_sub(limit);
    entries.truncate(limit);
    Ok(Listing { entries, omitted })
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    File,
    Folder,
}

// Names for new files and folders: one path component, visible in the browser,
// and valid on every platform, so notes stay portable.
pub(crate) fn checked_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    if name.contains(['/', '\\']) {
        return Err("Names cannot contain / or \\. Create the folder first.".into());
    }
    if name.starts_with('.') {
        return Err("Names starting with a dot are hidden in the file browser.".into());
    }
    if let Some(c) = name
        .chars()
        .find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(format!("Names cannot contain {c:?}."));
    }
    if name.ends_with('.') {
        return Err("Names cannot end with a dot.".into());
    }
    Ok(name)
}

fn known_extension(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

// New files are Markdown unless named as Markdown or text already.
pub(crate) fn file_name(name: &str) -> String {
    if known_extension(name) {
        name.to_owned()
    } else {
        format!("{name}.md")
    }
}

// Creates an empty file or a folder inside `folder`; never replaces anything.
fn create(root: &Root, folder: &Path, name: &str, kind: Kind) -> Result<PathBuf, String> {
    let name = checked_name(name)?;
    if !root.contains(folder) || !folder.is_dir() {
        return Err("That folder is outside the open folder.".into());
    }
    let path = match kind {
        Kind::File => folder.join(file_name(name)),
        Kind::Folder => folder.join(name),
    };
    let created = match kind {
        Kind::File => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop),
        Kind::Folder => fs::create_dir(&path),
    };
    created.map_err(|error| match error.kind() {
        io::ErrorKind::AlreadyExists => format!(
            "{} already exists.",
            path.file_name().unwrap_or_default().to_string_lossy()
        ),
        _ => error.to_string(),
    })?;
    Ok(path)
}

// Two names for one entry, as on case-insensitive file systems (`a.md` and `A.md`).
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((fs::symlink_metadata(a), fs::symlink_metadata(b)),
            (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
            GetFileInformationByHandleEx,
        };
        // Keep both handles open while comparing ids. Open the entry itself,
        // including folders and links, rather than following a link's target.
        let entry = |path: &Path| -> Option<(fs::File, FILE_ID_INFO)> {
            let file = fs::OpenOptions::new()
                .access_mode(0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .ok()?;
            // SAFETY: FILE_ID_INFO contains only integer fields and the API
            // receives a correctly sized, writable buffer and a live handle.
            let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
            let success = unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileIdInfo,
                    (&mut info as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            };
            (success != 0).then_some((file, info))
        };
        matches!((entry(a), entry(b)), (Some((_a, a)), Some((_b, b)))
            if a.VolumeSerialNumber == b.VolumeSerialNumber
                && a.FileId.Identifier == b.FileId.Identifier)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    pub(crate) path: String,
    /// Open documents that moved, with their new paths.
    pub(crate) documents: Vec<(DocumentId, String)>,
}

// Renames within the same folder. A file keeps its extension unless the new
// name gives Markdown or text one. Never replaces another entry.
pub(crate) fn rename(
    documents: &Documents,
    root: &Root,
    path: &Path,
    name: &str,
) -> Result<Renamed, String> {
    root.entry(path)?;
    let name = checked_name(name)?;
    let folder = fs::metadata(path).is_ok_and(|meta| meta.is_dir());
    let name = match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if !folder && !known_extension(name) => format!("{name}.{extension}"),
        _ if !folder => file_name(name),
        _ => name.to_owned(),
    };
    let to = path.with_file_name(&name);
    let text = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "The name is not valid Unicode.".to_owned())
    };
    if to == path {
        return Ok(Renamed {
            path: text(&to)?,
            documents: Vec::new(),
        });
    }
    let same = fs::symlink_metadata(&to).is_ok() && same_entry(path, &to);
    if fs::symlink_metadata(&to).is_ok() && !same {
        return Err(format!("{name} already exists."));
    }
    // The rename itself refuses to replace, in case something appears at `to`
    // after the check above.
    let moved = documents
        .rename(path, &to, same)
        .map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => format!("{name} already exists."),
            _ => error.to_string(),
        })?;
    Ok(Renamed {
        path: text(&to)?,
        documents: moved
            .into_iter()
            .filter_map(|(id, path)| Some((id, path.to_str()?.to_owned())))
            .collect(),
    })
}

// The workspace is remembered as one line in Textgate's config folder.
fn stored_at(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .config_dir()
            .ok()?
            .join("textgate")
            .join("workspace"),
    )
}

fn store(file: &Path, folder: Option<&Path>) -> io::Result<()> {
    match folder {
        Some(folder) => {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?;
            }
            let text = folder
                .to_str()
                .ok_or_else(|| io::Error::other("The folder path is not valid Unicode."))?;
            fs::write(file, text)
        }
        None => match fs::remove_file(file) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        },
    }
}

fn stored(file: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(file).ok()?;
    let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
    path.is_absolute().then_some(path)
}

/// Reopens the remembered workspace at startup, if the folder still exists.
pub fn restore(app: &tauri::AppHandle) {
    let folder = stored_at(app).and_then(|file| stored(&file));
    if let Some(root) = folder.and_then(|folder| Root::new(&folder).ok()) {
        app.state::<Documents>().set_root(Some(root));
    }
}

fn opened(documents: &Documents, path: &Path) -> Result<Root, String> {
    if !documents.chosen(path) {
        return Err("Choose the folder through File → Open Folder first.".into());
    }
    Root::new(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_workspace(
    app: tauri::AppHandle,
    documents: tauri::State<'_, Documents>,
    path: PathBuf,
) -> Result<Workspace, String> {
    let root = opened(&documents, &path)?;
    Ok(adopt(&app, &documents, root))
}

// Makes a folder the workspace and remembers it for the next launch.
fn adopt(app: &tauri::AppHandle, documents: &Documents, root: Root) -> Workspace {
    if let Some(file) = stored_at(app) {
        // Not remembering it is no reason to refuse the folder now.
        let _ = store(&file, Some(&root.given));
    }
    let workspace = Workspace::from(&root);
    documents.set_root(Some(root));
    workspace
}

/// A folder passed on the command line or by the OS, which grants it as the
/// workspace just as choosing it in the Open Folder dialog does.
pub fn launched(app: &tauri::AppHandle, path: &Path) -> Result<Workspace, String> {
    let root = Root::new(path).map_err(|error| error.to_string())?;
    Ok(adopt(app, &app.state::<Documents>(), root))
}

#[tauri::command]
pub fn workspace(documents: tauri::State<'_, Documents>) -> Option<Workspace> {
    documents.root().as_ref().map(Workspace::from)
}

#[tauri::command]
pub fn close_workspace(app: tauri::AppHandle, documents: tauri::State<'_, Documents>) {
    documents.set_root(None);
    if let Some(file) = stored_at(&app) {
        let _ = store(&file, None);
    }
}

#[tauri::command]
pub async fn list_folder(app: tauri::AppHandle, path: PathBuf) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .state::<Documents>()
            .root()
            .ok_or("No folder is open.")?;
        if !root.contains(&path) {
            return Err("That folder is outside the open folder.".into());
        }
        list(&root, &path, LIMIT).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_entry(
    app: tauri::AppHandle,
    folder: PathBuf,
    name: String,
    kind: Kind,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .state::<Documents>()
            .root()
            .ok_or("No folder is open.")?;
        let path = create(&root, &folder, &name, kind)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "The name is not valid Unicode.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn rename_entry(
    app: tauri::AppHandle,
    path: PathBuf,
    name: String,
) -> Result<Renamed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let documents = app.state::<Documents>();
        let root = documents.root().ok_or("No folder is open.")?;
        rename(&documents, &root, &path, &name)
    })
    .await
    .map_err(|error| error.to_string())?
}

// Moves an entry to the system trash, never deleting it outright. Returns the
// open documents whose files went with it; they stay open.
fn trash_entry_in(
    documents: &Documents,
    root: &Root,
    path: &Path,
) -> Result<Vec<DocumentId>, String> {
    root.entry(path)?;
    let holding = documents.holding(path).map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let trash = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        // Finder scripting would ask for permission to control Finder.
        let mut trash = trash::TrashContext::default();
        trash.set_delete_method(DeleteMethod::NsFileManager);
        trash
    };
    #[cfg(not(target_os = "macos"))]
    let trash = trash::TrashContext::default();
    trash
        .delete(path)
        .map_err(|error| format!("Could not move it to the trash: {error}"))?;
    Ok(holding)
}

#[tauri::command]
pub async fn trash_entry(app: tauri::AppHandle, path: PathBuf) -> Result<Vec<DocumentId>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let documents = app.state::<Documents>();
        let root = documents.root().ok_or("No folder is open.")?;
        trash_entry_in(&documents, &root, &path)
    })
    .await
    .map_err(|error| error.to_string())?
}

// Shows an entry in the system file manager. Only for entries in the workspace,
// so the page cannot probe other paths.
#[tauri::command]
pub async fn reveal_entry(app: tauri::AppHandle, path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .state::<Documents>()
            .root()
            .ok_or("No folder is open.")?;
        if !root.contains(&path) || fs::symlink_metadata(&path).is_err() {
            return Err("That item is not in the open folder any more. Refresh the list.".into());
        }
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .map_err(|error| format!("Could not show it in the file manager: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[cfg(unix)]
    fn names(listing: &Listing) -> Vec<&str> {
        listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn the_root_contains_only_paths_that_resolve_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let outside = dir.path().join("outside");
        fs::create_dir_all(notes.join("sub")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "x").unwrap();
        fs::write(notes.join("a.md"), "x").unwrap();
        symlink(&outside, notes.join("escape")).unwrap();
        symlink(outside.join("secret.md"), notes.join("secret.md")).unwrap();
        symlink(notes.join("sub"), notes.join("inner")).unwrap();
        let root = Root::new(&notes).unwrap();
        assert!(root.contains(&notes));
        assert!(root.contains(&notes.join("a.md")));
        assert!(
            root.contains(&notes.join("sub/new.md")),
            "a file not created yet"
        );
        assert!(
            root.contains(&notes.join("inner/new.md")),
            "a link that stays inside"
        );
        assert!(!root.contains(&notes.join("escape/secret.md")));
        assert!(!root.contains(&notes.join("secret.md")));
        assert!(!root.contains(&notes.join("sub/../a.md")), ".. is refused");
        assert!(!root.contains(&notes.join("../outside/secret.md")));
        assert!(!root.contains(&outside.join("secret.md")));
        assert!(
            !root.contains(Path::new("a.md")),
            "relative paths are refused"
        );
        assert!(!root.contains(&notes.join("missing/deeper/new.md")));
        assert!(
            Root::new(&notes.join("a.md")).is_err(),
            "a file is not a folder"
        );
    }

    #[cfg(unix)]
    #[test]
    fn listings_show_folders_then_markdown_and_text_in_natural_order() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        for folder in ["Zeta", "alpha", ".git", "node_modules", "docs 10", "docs 2"] {
            fs::create_dir_all(notes.join(folder)).unwrap();
        }
        for file in [
            "note 10.md",
            "Note 2.MD",
            "b.markdown",
            "c.txt",
            "image.png",
            ".hidden.md",
            "README",
        ] {
            fs::write(notes.join(file), "x").unwrap();
        }
        fs::write(outside.join("away.md"), "x").unwrap();
        symlink(outside.join("away.md"), notes.join("away.md")).unwrap();
        symlink(notes.join("missing.md"), notes.join("broken.md")).unwrap();
        symlink(notes.join("c.txt"), notes.join("linked.txt")).unwrap();
        let root = Root::new(&notes).unwrap();
        let listing = list(&root, &notes, LIMIT).unwrap();
        assert_eq!(
            names(&listing),
            [
                "alpha",
                "docs 2",
                "docs 10",
                "Zeta",
                "b.markdown",
                "c.txt",
                "linked.txt",
                "Note 2.MD",
                "note 10.md"
            ]
        );
        assert_eq!(listing.omitted, 0);
        let alpha = &listing.entries[0];
        assert!(alpha.folder);
        assert_eq!(alpha.path, notes.join("alpha").to_str().unwrap());
        let limited = list(&root, &notes, 3).unwrap();
        assert_eq!(names(&limited), ["alpha", "docs 2", "docs 10"]);
        assert_eq!(limited.omitted, 6);
    }

    #[test]
    fn natural_order_compares_numbers_by_value() {
        let mut names = vec!["a10", "a2", "a02b", "A1", "b", "a"];
        names.sort_by(|a, b| natural(a, b));
        assert_eq!(names, ["a", "A1", "a2", "a02b", "a10", "b"]);
    }

    #[test]
    fn new_files_and_folders_are_created_inside_and_never_replace_anything() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let root = Root::new(&notes).unwrap();
        let file = create(&root, &notes, "  Ideas ", Kind::File).unwrap();
        assert_eq!(file, notes.join("Ideas.md"));
        assert_eq!(fs::read(&file).unwrap(), b"");
        for (name, expected) in [
            ("todo.txt", "todo.txt"),
            ("a.Markdown", "a.Markdown"),
            ("v1.2", "v1.2.md"),
            ("notes.org", "notes.org.md"),
        ] {
            assert_eq!(
                create(&root, &notes, name, Kind::File).unwrap(),
                notes.join(expected)
            );
        }
        let folder = create(&root, &notes, "Projects", Kind::Folder).unwrap();
        assert!(folder.is_dir());
        create(&root, &folder, "inside", Kind::File).unwrap();
        fs::write(&file, b"keep").unwrap();
        let error = create(&root, &notes, "Ideas", Kind::File).unwrap_err();
        assert_eq!(error, "Ideas.md already exists.");
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        assert!(create(&root, &notes, "Projects", Kind::Folder).is_err());
        for name in [
            "",
            "  ",
            "a/b",
            "a\\b",
            ".hidden",
            "..",
            "what?",
            "a:b",
            "end.",
            "tab\there",
        ] {
            assert!(create(&root, &notes, name, Kind::File).is_err(), "{name:?}");
        }
        assert!(create(&root, dir.path(), "outside", Kind::File).is_err());
        assert!(!dir.path().join("outside.md").exists());
        assert!(create(&root, &notes.join("missing"), "x", Kind::File).is_err());
    }

    #[test]
    fn case_distinct_files_are_never_treated_as_the_same_entry() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        {
            // Opt in where supported; ordinary Windows folders ignore case.
            let _ = std::process::Command::new("fsutil")
                .args(["file", "setCaseSensitiveInfo"])
                .arg(dir.path())
                .arg("enable")
                .output();
        }
        let (lower, upper) = (dir.path().join("a.md"), dir.path().join("A.md"));
        fs::write(&lower, b"lower").unwrap();
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&upper);
        match file {
            Ok(file) => drop(file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                eprintln!("case-distinct entry check requires a case-sensitive file system");
                return;
            }
            Err(error) => panic!("{error}"),
        }
        fs::write(&upper, b"upper").unwrap();
        assert!(!same_entry(&lower, &upper));
        let root = Root::new(dir.path()).unwrap();
        assert!(rename(&Documents::default(), &root, &lower, "A.md").is_err());
        assert_eq!(fs::read(&lower).unwrap(), b"lower");
        assert_eq!(fs::read(&upper).unwrap(), b"upper");
    }

    #[test]
    fn renaming_keeps_extensions_refuses_replacing_and_stays_inside() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(notes.join("folder")).unwrap();
        for name in ["a.md", "b.txt", "taken.md"] {
            fs::write(notes.join(name), name).unwrap();
        }
        fs::write(dir.path().join("outside.md"), b"x").unwrap();
        let root = Root::new(&notes).unwrap();
        let documents = Documents::default();
        let named = |path: &str, name: &str| {
            rename(&documents, &root, &notes.join(path), name).map(|renamed| renamed.path)
        };
        let path = |name: &str| notes.join(name).to_str().unwrap().to_owned();
        assert_eq!(named("a.md", "ideas"), Ok(path("ideas.md")));
        assert_eq!(named("b.txt", "list"), Ok(path("list.txt")));
        assert_eq!(named("list.txt", "list.md"), Ok(path("list.md")));
        assert_eq!(named("folder", "Projects v2"), Ok(path("Projects v2")));
        assert_eq!(
            named("ideas.md", "ideas"),
            Ok(path("ideas.md")),
            "unchanged"
        );
        assert_eq!(
            named("ideas.md", "Ideas"),
            Ok(path("Ideas.md")),
            "case only"
        );
        assert_eq!(
            named("Ideas.md", "taken"),
            Err("taken.md already exists.".into())
        );
        assert_eq!(fs::read(notes.join("taken.md")).unwrap(), b"taken.md");
        assert!(named("Ideas.md", "a/b").is_err());
        assert!(named("missing.md", "x").is_err());
        assert!(rename(&documents, &root, &dir.path().join("outside.md"), "y").is_err());
        assert!(rename(&documents, &root, &notes, "renamed").is_err());
        assert!(notes.is_dir());
    }

    #[test]
    fn trashing_refuses_the_workspace_and_anything_outside() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir(&notes).unwrap();
        fs::write(dir.path().join("outside.md"), b"x").unwrap();
        let root = Root::new(&notes).unwrap();
        let documents = Documents::default();
        // Checked before the trash is touched, so these never reach it.
        assert!(trash_entry_in(&documents, &root, &notes).is_err());
        assert!(trash_entry_in(&documents, &root, &dir.path().join("outside.md")).is_err());
        assert!(trash_entry_in(&documents, &root, &notes.join("missing.md")).is_err());
        assert!(notes.is_dir() && dir.path().join("outside.md").exists());
    }

    #[test]
    fn the_workspace_is_remembered_and_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config/textgate/workspace");
        assert_eq!(stored(&file), None);
        store(&file, Some(dir.path())).unwrap();
        assert_eq!(stored(&file).as_deref(), Some(dir.path()));
        store(&file, None).unwrap();
        store(&file, None).unwrap();
        assert_eq!(stored(&file), None);
        fs::write(&file, "relative/path").unwrap();
        assert_eq!(stored(&file), None, "only absolute paths are trusted");
    }

    #[test]
    fn only_a_folder_chosen_in_the_dialog_becomes_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let documents = Documents::default();
        assert!(opened(&documents, dir.path()).is_err());
        documents.granter()(dir.path());
        let root = opened(&documents, dir.path()).unwrap();
        assert_eq!(Workspace::from(&root).path, dir.path().to_str().unwrap());
        let file = dir.path().join("a.md");
        fs::write(&file, "x").unwrap();
        documents.granter()(&file);
        assert!(opened(&documents, &file).is_err(), "a file is not a folder");
    }
}
