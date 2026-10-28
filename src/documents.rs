use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveError {
    Conflict { missing: bool },
    Io { message: String },
}
impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}
fn failure(message: &str) -> SaveError {
    SaveError::Io {
        message: message.into(),
    }
}

// Saves through a symbolic link go to the file it points to, as in most
// editors, so the link itself is kept. Directories and special files are refused.
fn resolve(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::other("This link points to a file that no longer exists.")
            } else {
                error
            }
        }),
        _ => Ok(path.to_path_buf()),
    }
}

fn metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(meta)),
        Ok(_) => Err(io::Error::other(
            "Choose a regular file; folders and special files are not supported.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn snapshot(path: &Path) -> io::Result<Option<Vec<u8>>> {
    if metadata(path)?.is_none() {
        return Ok(None);
    }
    fs::read(path).map(Some)
}

fn save(path: &Path, bytes: &[u8], expected: Option<&[u8]>) -> Result<(), SaveError> {
    save_with(path, expected, |file| file.write_all(bytes))
}

fn save_with(
    path: &Path,
    expected: Option<&[u8]>,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> Result<(), SaveError> {
    let conflict = |current: &Option<Vec<u8>>| SaveError::Conflict {
        missing: current.is_none(),
    };
    let current = snapshot(path)?;
    if current.as_deref() != expected {
        return Err(conflict(&current));
    }
    let original = metadata(path)?;
    if let Some(meta) = &original {
        if meta.permissions().readonly() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "The document is read-only.",
            )
            .into());
        }
        // Replacing the file would silently separate it from its other links.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 {
                return Err(failure(
                    "This file has hard links. Use Save As to avoid breaking them.",
                ));
            }
        }
        // Permission bits alone miss files owned by someone else in a writable folder.
        fs::OpenOptions::new().append(true).open(path)?;
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = tempfile::Builder::new();
    builder.prefix(".textgate-");
    // Temporary files are private; a new document gets the usual umask-based
    // permissions instead, as other editors create it.
    #[cfg(unix)]
    if original.is_none() {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temporary = builder.tempfile_in(parent)?;
    write(temporary.as_file_mut())?;
    if let Some(meta) = original {
        temporary.as_file().set_permissions(meta.permissions())?;
    }
    temporary.as_file().sync_all()?;
    // Recheck after writing the temporary file. This is conflict detection,
    // not a filesystem-wide lock against other editors racing the final rename.
    let current = snapshot(path)?;
    if current.as_deref() != expected {
        return Err(conflict(&current));
    }
    persist(temporary, path, expected.is_none())?;
    // Best effort directory durability: some filesystems cannot sync directories.
    // A failure here must not report an unsuccessful save after replacement.
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

// Sync clients and virus scanners on Windows briefly hold files open, which
// makes the replacement fail. Retry for a moment before reporting it.
fn persist(
    mut temporary: tempfile::NamedTempFile,
    path: &Path,
    create: bool,
) -> Result<(), SaveError> {
    for attempt in 0.. {
        let result = if create {
            temporary.persist_noclobber(path)
        } else {
            temporary.persist(path)
        };
        match result {
            Ok(_) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && attempt < 5
                    && error.error.kind() == io::ErrorKind::PermissionDenied =>
            {
                temporary = error.file;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(error)
                if cfg!(windows) && error.error.kind() == io::ErrorKind::PermissionDenied =>
            {
                return Err(failure(
                    "Another program is using the file, so it was not replaced. Try saving again in a moment.",
                ));
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    unreachable!()
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveMode {
    /// Save the open document; the disk must still match what was opened or saved.
    Save,
    /// The native Save dialog already confirmed replacing the destination.
    Replace,
    /// The user approved the disk version reported by the last conflict.
    Overwrite,
}

type Baseline = Option<(PathBuf, Option<Vec<u8>>)>;

// The exact disk bytes stay here, not in the webview, so saving a large
// document never sends a copy of the original file over IPC.
#[derive(Default)]
pub struct Documents {
    granted: Arc<Mutex<HashSet<PathBuf>>>,
    opening: Mutex<Baseline>,
    baseline: Mutex<Baseline>,
    approved: Mutex<Baseline>,
}

fn normalize(path: &Path) -> PathBuf {
    path.components().collect()
}

impl Documents {
    // Files chosen in the native Open and Save dialogs. These are the exact
    // paths the user picked, unlike the fs scope, which resolves symlinks and
    // so refuses files reached through linked folders.
    #[cfg(test)]
    fn grant(&self, path: &Path) {
        self.granted.lock().unwrap().insert(normalize(path));
    }
    pub fn granter(&self) -> impl Fn(&Path) + Send + 'static {
        let granted = self.granted.clone();
        move |path| {
            granted.lock().unwrap().insert(normalize(path));
        }
    }

    fn target(&self, path: &Path) -> Result<PathBuf, SaveError> {
        if !path.is_absolute() || !self.granted.lock().unwrap().contains(&normalize(path)) {
            return Err(failure("Choose the file through Open or Save As first."));
        }
        Ok(resolve(path)?)
    }

    fn open(&self, path: &Path) -> Result<Vec<u8>, SaveError> {
        let target = self.target(path)?;
        let bytes = snapshot(&target)?.ok_or_else(|| failure("The file no longer exists."))?;
        *self.opening.lock().unwrap() = Some((target, Some(bytes.clone())));
        Ok(bytes)
    }

    // Opening can still be cancelled after reading (unsaved-changes prompt), so
    // the baseline changes only once the editor shows the new document.
    fn keep(&self, path: &Path) -> Result<(), SaveError> {
        let target = self.target(path)?;
        let mut opening = self.opening.lock().unwrap();
        if opening
            .as_ref()
            .is_some_and(|(opened, _)| *opened == target)
        {
            *self.baseline.lock().unwrap() = opening.take();
        }
        Ok(())
    }

    fn save(&self, path: &Path, contents: &[u8], mode: SaveMode) -> Result<(), SaveError> {
        let target = self.target(path)?;
        let stored = |slot: &Mutex<Baseline>| {
            slot.lock()
                .unwrap()
                .as_ref()
                .filter(|(stored, _)| *stored == target)
                .map(|(_, bytes)| bytes.clone())
        };
        let expected = match mode {
            SaveMode::Overwrite => stored(&self.approved),
            SaveMode::Save => stored(&self.baseline),
            // A Save As onto the open document still checks for outside edits.
            SaveMode::Replace => stored(&self.baseline).or_else(|| snapshot(&target).ok()),
        }
        .ok_or_else(|| failure("Open the document again before saving."))?;
        match save(&target, contents, expected.as_deref()) {
            Ok(()) => {
                *self.baseline.lock().unwrap() = Some((target, Some(contents.to_vec())));
                *self.approved.lock().unwrap() = None;
                Ok(())
            }
            Err(SaveError::Conflict { missing }) => {
                // Approval covers only the version on disk now; a later outside
                // edit produces another conflict rather than being overwritten.
                *self.approved.lock().unwrap() = Some((target.clone(), snapshot(&target)?));
                Err(SaveError::Conflict { missing })
            }
            Err(error) => Err(error),
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, SaveError> + Send + 'static,
) -> Result<T, SaveError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| failure(&error.to_string()))?
}

#[tauri::command]
pub async fn open_document(
    app: tauri::AppHandle,
    path: PathBuf,
) -> Result<tauri::ipc::Response, SaveError> {
    use tauri::Manager;
    blocking(move || {
        let bytes = app.state::<Documents>().open(&path)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub fn keep_document(
    documents: tauri::State<'_, Documents>,
    path: PathBuf,
) -> Result<(), SaveError> {
    documents.keep(&path)
}

#[tauri::command]
pub async fn save_document(
    app: tauri::AppHandle,
    path: PathBuf,
    contents: String,
    mode: SaveMode,
) -> Result<(), SaveError> {
    use tauri::Manager;
    blocking(move || {
        app.state::<Documents>()
            .save(&path, contents.as_bytes(), mode)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_exact_bytes_and_detects_same_size_changes_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let original = b"\xef\xbb\xbfhello\r\n";
        save(&path, original, None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, b"\xef\xbb\xbfother\r\n").unwrap();
        assert!(matches!(
            save(&path, b"edited", Some(original)),
            Err(SaveError::Conflict { missing: false })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbfother\r\n");
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            save(&path, b"edited", Some(original)),
            Err(SaveError::Conflict { missing: true })
        ));
        assert!(!path.exists());
        save(&path, b"edited", None).unwrap();
        save(&path, b"next", Some(b"edited")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"next");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_unexpected_existing_files_and_invalid_destinations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"keep").unwrap();
        assert!(matches!(
            save(&path, b"new", None),
            Err(SaveError::Conflict { .. })
        ));
        assert!(save(dir.path(), b"new", None).is_err());
        assert!(save(&dir.path().join("missing/notes.md"), b"new", None).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
    }

    #[test]
    fn failed_partial_write_preserves_original_and_cleans_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"original").unwrap();
        let result = save_with(&path, Some(b"original"), |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("simulated disk full"))
        });
        assert!(matches!(result, Err(SaveError::Io { .. })));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn external_edit_during_temporary_write_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"original").unwrap();
        let result = save_with(&path, Some(b"original"), |file| {
            file.write_all(b"editor")?;
            fs::write(&path, b"external")
        });
        assert!(matches!(result, Err(SaveError::Conflict { .. })));
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn documents_keep_the_baseline_and_require_approval_for_outside_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"\xef\xbb\xbfold\r\n").unwrap();
        let documents = Documents::default();
        assert!(documents.open(&path).is_err(), "not chosen in a dialog");
        documents.grant(&path);
        assert_eq!(documents.open(&path).unwrap(), b"\xef\xbb\xbfold\r\n");
        // Saving before the editor keeps the opened document has no baseline.
        assert!(documents.save(&path, b"x", SaveMode::Save).is_err());
        documents.keep(&path).unwrap();
        documents.save(&path, b"one", SaveMode::Save).unwrap();
        documents.save(&path, b"two", SaveMode::Save).unwrap();
        fs::write(&path, b"outside").unwrap();
        assert!(matches!(
            documents.save(&path, b"three", SaveMode::Save),
            Err(SaveError::Conflict { missing: false })
        ));
        // A newer outside edit after the prompt is not covered by the approval.
        fs::write(&path, b"newer").unwrap();
        assert!(matches!(
            documents.save(&path, b"three", SaveMode::Overwrite),
            Err(SaveError::Conflict { .. })
        ));
        documents
            .save(&path, b"three", SaveMode::Overwrite)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"three");
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            documents.save(&path, b"four", SaveMode::Save),
            Err(SaveError::Conflict { missing: true })
        ));
        documents.save(&path, b"four", SaveMode::Overwrite).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"four");
    }

    #[test]
    fn save_as_replaces_an_existing_destination_once_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.md");
        fs::write(&path, b"existing").unwrap();
        let documents = Documents::default();
        let grant = documents.granter();
        grant(&path);
        documents.save(&path, b"copy", SaveMode::Replace).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"copy");
        let created = dir.path().join("new.md");
        documents.grant(&created);
        documents.save(&created, b"new", SaveMode::Replace).unwrap();
        assert_eq!(fs::read(&created).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn links_save_through_to_their_target_and_hard_links_open_but_do_not_save() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let file = real.join("notes.md");
        fs::write(&file, b"old").unwrap();
        // A linked file, and a file reached through a linked folder.
        let link = dir.path().join("link.md");
        symlink(&file, &link).unwrap();
        let folder = dir.path().join("folder");
        symlink(&real, &folder).unwrap();
        let documents = Documents::default();
        for path in [&link, &folder.join("notes.md")] {
            documents.grant(path);
            assert_eq!(documents.open(path).unwrap(), fs::read(&file).unwrap());
            documents.keep(path).unwrap();
            documents.save(path, b"new", SaveMode::Save).unwrap();
            assert!(
                fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(fs::read(&file).unwrap(), b"new");
            fs::write(&file, b"old").unwrap();
        }
        let broken = dir.path().join("broken.md");
        symlink(dir.path().join("gone.md"), &broken).unwrap();
        documents.grant(&broken);
        assert!(documents.open(&broken).is_err());

        let hard = dir.path().join("hard.md");
        fs::hard_link(&file, &hard).unwrap();
        documents.grant(&hard);
        assert_eq!(documents.open(&hard).unwrap(), b"old");
        documents.keep(&hard).unwrap();
        assert!(documents.save(&hard, b"bad", SaveMode::Save).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"old");
    }

    // Read the umask without setting it, which would race other tests. Linux
    // reports it in /proc; elsewhere assume the common default.
    #[cfg(unix)]
    fn process_umask() -> u32 {
        let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
        status
            .lines()
            .find_map(|line| line.strip_prefix("Umask:"))
            .and_then(|value| u32::from_str_radix(value.trim(), 8).ok())
            .unwrap_or(0o022)
    }

    #[cfg(unix)]
    #[test]
    fn preserves_permissions_and_rejects_readonly_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        save(&path, b"new", Some(b"old")).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        assert!(save(&path, b"bad", Some(b"new")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        // New files follow the umask rather than the private temporary file's 0600.
        let created = dir.path().join("created.md");
        save(&created, b"new", None).unwrap();
        let umask = process_umask();
        assert_eq!(
            fs::metadata(&created).unwrap().permissions().mode() & 0o777,
            0o666 & !umask
        );
    }
}
