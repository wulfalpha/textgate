use crate::workspace::Root;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveError {
    Conflict {
        missing: bool,
    },
    /// The file is already open in another document.
    AlreadyOpen {
        document: u32,
        message: String,
    },
    Io {
        message: String,
    },
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

pub type DocumentId = u32;
pub(crate) type Version = (PathBuf, Option<Vec<u8>>);

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskChange {
    document: DocumentId,
    changed: bool,
    missing: bool,
    error: Option<String>,
}

// What Rust knows about one open document (one tab).
#[derive(Default)]
struct Slots {
    /// Read by Open but not yet shown; opening can still be cancelled.
    opening: Option<Version>,
    /// The file's bytes when this document last opened or saved it.
    baseline: Option<Version>,
    /// Where the baseline's file really is, to find it under another path.
    file: Option<PathBuf>,
    /// The disk version the user approved overwriting after a conflict.
    approved: Option<Version>,
}

// The exact disk bytes stay here, not in the webview, so saving a large
// document never sends a copy of the original file over IPC.
#[derive(Default)]
pub struct Documents {
    granted: Arc<Mutex<HashSet<PathBuf>>>,
    /// The open folder; files inside it need no individual grant.
    root: Mutex<Option<Root>>,
    next: AtomicU32,
    open: Mutex<HashMap<DocumentId, Slots>>,
}

fn normalize(path: &Path) -> PathBuf {
    path.components().collect()
}

// Two paths name the same file when they resolve to the same place, including
// through linked folders. A file that does not exist yet is placed by its folder.
fn identity(target: &Path) -> PathBuf {
    fs::canonicalize(target).unwrap_or_else(|_| {
        target
            .parent()
            .zip(target.file_name())
            .and_then(|(parent, name)| fs::canonicalize(parent).ok().map(|dir| dir.join(name)))
            .unwrap_or_else(|| normalize(target))
    })
}

// `path` moved along with `from`, if it is `from` or inside it.
/// Renames `from` to `to`, failing with `AlreadyExists` instead of replacing an
/// entry at `to`. A check beforehand cannot rule out another program creating
/// `to` just before the rename; these calls make the check and the rename one
/// step. A case-only rename (`a.md` to `A.md`) on a case-insensitive drive names
/// the same entry twice, so Unix callers pass `same` to use an ordinary rename.
/// Windows always uses its non-replacing native operation, including case changes.
pub fn rename_new(from: &Path, to: &Path, same: bool) -> io::Result<()> {
    // Windows can change case with MoveFileExW without enabling replacement.
    // Do not let a stale identity check enable a replacing rename there.
    #[cfg(windows)]
    let _ = same;
    #[cfg(unix)]
    if same {
        return fs::rename(from, to);
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = |path: &Path| {
            CString::new(path.as_os_str().as_bytes()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte")
            })
        };
        let (from_c, to_c) = (path(from)?, path(to)?);
        // SAFETY: both are valid NUL-terminated paths for the duration of the call.
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let result: libc::c_int = {
            let _ = (&from_c, &to_c);
            -2
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // Never fall back to a replacing rename on unsupported file systems.
        let unsupported = result == -2
            || matches!(
                error.raw_os_error(),
                Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP)
            );
        if unsupported {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "This file system does not support renaming without replacement. Rename the item in your file manager.",
            ));
        }
        Err(error)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain([0])
                .collect::<Vec<u16>>()
        };
        let (from_w, to_w) = (wide(from), wide(to));
        // Without MOVEFILE_REPLACE_EXISTING, MoveFileExW fails if `to` exists.
        // SAFETY: both are valid NUL-terminated wide strings for the call.
        if unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), 0) } != 0 {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }
}

fn moved(path: &Path, from: &Path, to: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(from).ok()?;
    Some(if rest.as_os_str().is_empty() {
        to.to_path_buf()
    } else {
        to.join(rest)
    })
}

// The file or folder itself, plus where it really is unless it is a link
// (moving or trashing a link leaves the file it points to in place).
fn places(path: &Path) -> io::Result<(PathBuf, Option<PathBuf>)> {
    let link = fs::symlink_metadata(path)?.file_type().is_symlink();
    Ok((
        normalize(path),
        (!link).then(|| fs::canonicalize(path)).transpose()?,
    ))
}

// Where a path that does not exist yet will really be, by its folder.
fn identity_in_folder(path: &Path) -> Option<PathBuf> {
    let (parent, name) = path.parent().zip(path.file_name())?;
    fs::canonicalize(parent).ok().map(|dir| dir.join(name))
}

fn gone() -> SaveError {
    failure("This document is no longer open.")
}

impl Documents {
    // Derived exclusively from native document baselines, never arbitrary paths
    // supplied by JavaScript. Parent watches survive atomic file replacement.
    pub(crate) fn watch_parents(&self) -> HashSet<PathBuf> {
        self.open
            .lock()
            .unwrap()
            .values()
            .filter_map(|slots| slots.baseline.as_ref()?.0.parent().map(Path::to_path_buf))
            .collect()
    }

    pub(crate) fn disk_changes(&self) -> Vec<DiskChange> {
        let originals: Vec<_> = self
            .open
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(&document, slots)| {
                slots.baseline.clone().map(|version| (document, version))
            })
            .collect();
        originals
            .into_iter()
            .map(|(document, (path, baseline))| match snapshot(&path) {
                Ok(current) => DiskChange {
                    document,
                    changed: current != baseline,
                    missing: current.is_none(),
                    error: None,
                },
                Err(error) => DiskChange {
                    document,
                    changed: false,
                    missing: false,
                    error: Some(error.to_string()),
                },
            })
            .collect()
    }

    /// Only document handles already owned by this process may be checkpointed.
    /// Paths and original bytes never come from the webview's checkpoint data.
    pub(crate) fn recovery_baselines(
        &self,
        ids: &[DocumentId],
    ) -> Result<Vec<Option<Version>>, SaveError> {
        let open = self.open.lock().unwrap();
        ids.iter()
            .map(|id| {
                open.get(id)
                    .map(|slots| slots.baseline.clone())
                    .ok_or_else(gone)
            })
            .collect()
    }

    /// Called only with records read by the native recovery store. Dirty
    /// buffers retain their old baseline; clean tabs read today's disk bytes.
    pub(crate) fn restore_recovery(
        &self,
        original: Option<Version>,
        contents: &str,
        dirty: bool,
    ) -> Result<(DocumentId, Option<PathBuf>, Vec<u8>), SaveError> {
        if original
            .as_ref()
            .is_some_and(|(path, _)| !path.is_absolute())
        {
            return Err(failure("The recovery file contains a relative path."));
        }
        let id = self.create();
        let result = (|| {
            let path = original.as_ref().map(|(path, _)| path.clone());
            if let Some(path) = &path {
                self.remember(path);
            }
            if !dirty && let Some((path, baseline)) = &original {
                let bytes = self.open_with(id, path, baseline.is_none())?;
                self.keep(id, path)?;
                return Ok((id, Some(path.clone()), bytes));
            }
            let mut open = self.open.lock().unwrap();
            if let Some(path) = &path {
                let file = identity(path);
                Self::check_free(&open, id, &file)?;
                open.get_mut(&id).ok_or_else(gone)?.file = Some(file);
            }
            open.get_mut(&id).ok_or_else(gone)?.baseline = original;
            Ok((id, path, contents.as_bytes().to_vec()))
        })();
        if result.is_err() {
            self.close(id);
        }
        result
    }

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

    /// Chosen in a native dialog or passed by the OS, exactly as given.
    pub fn chosen(&self, path: &Path) -> bool {
        self.granted.lock().unwrap().contains(&normalize(path))
    }

    // A file a tab has opened or saved stays allowed, so closing the folder it
    // came from does not stop that tab from saving.
    fn remember(&self, path: &Path) {
        self.granted.lock().unwrap().insert(normalize(path));
    }

    pub fn root(&self) -> Option<Root> {
        self.root.lock().unwrap().clone()
    }

    pub fn set_root(&self, root: Option<Root>) {
        *self.root.lock().unwrap() = root;
    }

    /// Renames a file or folder, moving the documents inside it along so they
    /// keep saving to the same file. Returns each moved document's new path.
    /// Never replaces an entry at `to`, except the same entry under another
    /// case (`same`).
    pub fn rename(
        &self,
        from: &Path,
        to: &Path,
        same: bool,
    ) -> io::Result<Vec<(DocumentId, PathBuf)>> {
        let (given, real) = places(from)?;
        let real_to = real.as_ref().and_then(|_| identity_in_folder(to));
        // Held across the rename (one quick call) so no save sees a half-moved state.
        let mut open = self.open.lock().unwrap();
        rename_new(from, to, same)?;
        let follow = |path: &Path| {
            moved(path, &given, to).or_else(|| {
                real.as_deref()
                    .zip(real_to.as_deref())
                    .and_then(|(real, real_to)| moved(path, real, real_to))
            })
        };
        let mut changed = Vec::new();
        for (&id, slots) in open.iter_mut() {
            for version in [&mut slots.opening, &mut slots.approved] {
                if let Some(path) = version.as_ref().and_then(|(path, _)| follow(path)) {
                    version.as_mut().unwrap().0 = path;
                }
            }
            let file = slots.file.as_deref().and_then(follow);
            let target = slots.baseline.as_ref().and_then(|(path, _)| follow(path));
            if let Some(file) = &file {
                slots.file = Some(file.clone());
            }
            // A tab that reached the file another way (a linked folder) follows
            // the file itself.
            if let (Some(path), Some(baseline)) = (target.or(file), slots.baseline.as_mut()) {
                baseline.0 = path.clone();
                changed.push((id, path));
            }
        }
        drop(open);
        for (_, path) in &changed {
            self.remember(path);
        }
        Ok(changed)
    }

    /// The documents holding `path` or a file inside it, before it is removed.
    pub fn holding(&self, path: &Path) -> io::Result<Vec<DocumentId>> {
        let (given, real) = places(path)?;
        let inside = |file: &Path| {
            file.starts_with(&given) || real.as_deref().is_some_and(|real| file.starts_with(real))
        };
        Ok(self
            .open
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, slots)| {
                slots.file.as_deref().is_some_and(inside)
                    || slots
                        .baseline
                        .as_ref()
                        .is_some_and(|(path, _)| inside(path))
            })
            .map(|(&id, _)| id)
            .collect())
    }

    fn create(&self) -> DocumentId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().unwrap().insert(id, Slots::default());
        id
    }

    pub(crate) fn close(&self, document: DocumentId) {
        self.open.lock().unwrap().remove(&document);
    }

    fn target(&self, path: &Path) -> Result<PathBuf, SaveError> {
        let inside = || self.root().is_some_and(|root| root.contains(path));
        if !path.is_absolute() || !(self.chosen(path) || inside()) {
            return Err(failure(
                "Choose the file through Open, Save As, or a native file-open request first.",
            ));
        }
        Ok(resolve(path)?)
    }

    // A file belongs to at most one document: two tabs editing one file would
    // each see the other's saves as outside edits.
    fn check_free(
        open: &HashMap<DocumentId, Slots>,
        document: DocumentId,
        file: &Path,
    ) -> Result<(), SaveError> {
        match open
            .iter()
            .find(|(id, slots)| **id != document && slots.file.as_deref() == Some(file))
        {
            Some((&holder, _)) => Err(SaveError::AlreadyOpen {
                document: holder,
                message: "That file is open in another tab. Close it there first.".into(),
            }),
            None if open.contains_key(&document) => Ok(()),
            None => Err(gone()),
        }
    }

    #[cfg(test)]
    fn open(&self, document: DocumentId, path: &Path) -> Result<Vec<u8>, SaveError> {
        self.open_with(document, path, false)
    }

    fn open_with(
        &self,
        document: DocumentId,
        path: &Path,
        allow_missing: bool,
    ) -> Result<Vec<u8>, SaveError> {
        let target = self.target(path)?;
        let file = identity(&target);
        Self::check_free(&self.open.lock().unwrap(), document, &file)?;
        let bytes = snapshot(&target)?;
        if bytes.is_none() {
            if !allow_missing {
                return Err(failure("The file no longer exists."));
            }
            if !target.parent().is_some_and(Path::is_dir) {
                return Err(failure(
                    "The parent folder does not exist. Create it before opening a new file.",
                ));
            }
        }
        let mut open = self.open.lock().unwrap();
        open.get_mut(&document).ok_or_else(gone)?.opening = Some((target, bytes.clone()));
        Ok(bytes.unwrap_or_default())
    }

    // Opening can still be cancelled after reading (unsaved-changes prompt), so
    // the baseline changes only once the editor shows the new document.
    fn keep(&self, document: DocumentId, path: &Path) -> Result<(), SaveError> {
        let target = self.target(path)?;
        let file = identity(&target);
        let mut open = self.open.lock().unwrap();
        // Checked again: another document may have opened the file meanwhile.
        Self::check_free(&open, document, &file)?;
        let slots = open.get_mut(&document).ok_or_else(gone)?;
        if slots
            .opening
            .as_ref()
            .is_some_and(|(opened, _)| *opened == target)
        {
            slots.baseline = slots.opening.take();
            slots.file = Some(file);
            slots.approved = None;
            drop(open);
            self.remember(path);
        }
        Ok(())
    }

    fn save(
        &self,
        document: DocumentId,
        path: &Path,
        contents: &[u8],
        mode: SaveMode,
    ) -> Result<(), SaveError> {
        let target = self.target(path)?;
        let file = identity(&target);
        // The lock is held only to read and update the slots, never for disk
        // access, so a slow save in one tab does not block the others.
        let stored = {
            let open = self.open.lock().unwrap();
            Self::check_free(&open, document, &file)?;
            let slots = &open[&document];
            let stored = |slot: &Option<Version>| {
                slot.as_ref()
                    .filter(|(stored, _)| *stored == target)
                    .map(|(_, bytes)| bytes.clone())
            };
            match mode {
                SaveMode::Overwrite => stored(&slots.approved),
                SaveMode::Save | SaveMode::Replace => stored(&slots.baseline),
            }
        };
        let expected = match (stored, mode) {
            (Some(bytes), _) => Some(bytes),
            // A Save As onto another file checks it is still what the dialog confirmed.
            (None, SaveMode::Replace) => snapshot(&target).ok(),
            (None, _) => None,
        }
        .ok_or_else(|| failure("Open the document again before saving."))?;
        match save(&target, contents, expected.as_deref()) {
            Ok(()) => {
                // A newly created file now resolves fully.
                let file = identity(&target);
                if let Some(slots) = self.open.lock().unwrap().get_mut(&document) {
                    slots.file = Some(file);
                    slots.baseline = Some((target, Some(contents.to_vec())));
                    slots.approved = None;
                }
                self.remember(path);
                Ok(())
            }
            Err(SaveError::Conflict { missing }) => {
                // Approval covers only the version on disk now; a later outside
                // edit produces another conflict rather than being overwritten.
                let disk = snapshot(&target)?;
                if let Some(slots) = self.open.lock().unwrap().get_mut(&document) {
                    slots.approved = Some((target, disk));
                }
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
pub fn new_document(documents: tauri::State<'_, Documents>) -> DocumentId {
    documents.create()
}

#[tauri::command]
pub fn close_document(documents: tauri::State<'_, Documents>, document: DocumentId) {
    documents.close(document);
}

#[tauri::command]
pub async fn open_document(
    app: tauri::AppHandle,
    document: DocumentId,
    path: PathBuf,
    allow_missing: Option<bool>,
) -> Result<tauri::ipc::Response, SaveError> {
    use tauri::Manager;
    blocking(move || {
        let bytes =
            app.state::<Documents>()
                .open_with(document, &path, allow_missing.unwrap_or(false))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub fn keep_document(
    documents: tauri::State<'_, Documents>,
    document: DocumentId,
    path: PathBuf,
) -> Result<(), SaveError> {
    documents.keep(document, &path)
}

#[tauri::command]
pub async fn save_document(
    app: tauri::AppHandle,
    document: DocumentId,
    path: PathBuf,
    contents: String,
    mode: SaveMode,
) -> Result<(), SaveError> {
    use tauri::Manager;
    blocking(move || {
        app.state::<Documents>()
            .save(document, &path, contents.as_bytes(), mode)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_checks_report_exact_changes_without_advancing_the_save_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"\xef\xbb\xbfhello\r\n").unwrap();
        let documents = Documents::default();
        let id = documents
            .restore_recovery(Some((path.clone(), None)), "", false)
            .unwrap()
            .0;
        assert!(!documents.disk_changes()[0].changed);
        fs::write(&path, b"\xef\xbb\xbfother\r\n").unwrap();
        assert_eq!(
            documents.disk_changes(),
            vec![DiskChange {
                document: id,
                changed: true,
                missing: false,
                error: None,
            }]
        );
        assert!(matches!(
            documents.save(id, &path, b"unsaved", SaveMode::Save),
            Err(SaveError::Conflict { missing: false })
        ));
        fs::remove_file(&path).unwrap();
        assert!(documents.disk_changes()[0].missing);
        assert!(matches!(
            documents.save(id, &path, b"unsaved", SaveMode::Save),
            Err(SaveError::Conflict { missing: true })
        ));
        documents.close(id);
        assert!(documents.disk_changes().is_empty());
        assert!(documents.watch_parents().is_empty());
    }

    #[test]
    fn recovered_dirty_buffers_keep_the_old_baseline_and_detect_outside_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"outside edit").unwrap();
        let documents = Documents::default();
        let (id, _, recovered) = documents
            .restore_recovery(
                Some((path.clone(), Some(b"old disk bytes".to_vec()))),
                "unsaved buffer",
                true,
            )
            .unwrap();
        assert_eq!(recovered, b"unsaved buffer");
        assert!(matches!(
            documents.save(id, &path, b"unsaved buffer", SaveMode::Save),
            Err(SaveError::Conflict { missing: false })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"outside edit");
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            documents.save(id, &path, b"unsaved buffer", SaveMode::Save),
            Err(SaveError::Conflict { missing: true })
        ));
        assert!(!path.exists());
    }

    #[test]
    fn restored_clean_tabs_use_a_fresh_baseline_and_missing_prepared_files_stay_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"new disk bytes").unwrap();
        let documents = Documents::default();
        let (id, _, bytes) = documents
            .restore_recovery(
                Some((path.clone(), Some(b"old disk bytes".to_vec()))),
                "old disk bytes",
                false,
            )
            .unwrap();
        assert_eq!(bytes, b"new disk bytes");
        documents
            .save(id, &path, b"explicit save", SaveMode::Save)
            .unwrap();
        let missing = dir.path().join("new.md");
        let (id, _, bytes) = documents
            .restore_recovery(Some((missing.clone(), None)), "", false)
            .unwrap();
        assert!(bytes.is_empty() && !missing.exists());
        documents
            .save(id, &missing, b"created on Save", SaveMode::Save)
            .unwrap();
        assert_eq!(fs::read(&missing).unwrap(), b"created on Save");
    }

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
        let doc = documents.create();
        assert!(
            documents.open(doc, &path).is_err(),
            "not chosen in a dialog"
        );
        documents.grant(&path);
        assert_eq!(documents.open(doc, &path).unwrap(), b"\xef\xbb\xbfold\r\n");
        // Saving before the editor keeps the opened document has no baseline.
        assert!(documents.save(doc, &path, b"x", SaveMode::Save).is_err());
        documents.keep(doc, &path).unwrap();
        documents.save(doc, &path, b"one", SaveMode::Save).unwrap();
        documents.save(doc, &path, b"two", SaveMode::Save).unwrap();
        fs::write(&path, b"outside").unwrap();
        assert!(matches!(
            documents.save(doc, &path, b"three", SaveMode::Save),
            Err(SaveError::Conflict { missing: false })
        ));
        // A newer outside edit after the prompt is not covered by the approval.
        fs::write(&path, b"newer").unwrap();
        assert!(matches!(
            documents.save(doc, &path, b"three", SaveMode::Overwrite),
            Err(SaveError::Conflict { .. })
        ));
        documents
            .save(doc, &path, b"three", SaveMode::Overwrite)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"three");
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            documents.save(doc, &path, b"four", SaveMode::Save),
            Err(SaveError::Conflict { missing: true })
        ));
        documents
            .save(doc, &path, b"four", SaveMode::Overwrite)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"four");
    }

    #[test]
    fn each_document_keeps_its_own_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let [first, second] = ["a.md", "b.md"].map(|name| dir.path().join(name));
        let documents = Documents::default();
        let [a, b] = [documents.create(), documents.create()];
        assert_ne!(a, b);
        for (doc, path) in [(a, &first), (b, &second)] {
            fs::write(path, b"old").unwrap();
            documents.grant(path);
            documents.open(doc, path).unwrap();
            documents.keep(doc, path).unwrap();
        }
        // A conflict, and approval to overwrite, in one tab leave the other alone.
        fs::write(&first, b"outside").unwrap();
        assert!(matches!(
            documents.save(a, &first, b"mine", SaveMode::Save),
            Err(SaveError::Conflict { .. })
        ));
        documents
            .save(b, &second, b"saved", SaveMode::Save)
            .unwrap();
        assert!(
            documents
                .save(b, &second, b"x", SaveMode::Overwrite)
                .is_err()
        );
        documents
            .save(a, &first, b"mine", SaveMode::Overwrite)
            .unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"mine");
        assert_eq!(fs::read(&second).unwrap(), b"saved");
        // A closed document is forgotten; its id is not reused.
        documents.close(a);
        assert!(documents.save(a, &first, b"late", SaveMode::Save).is_err());
        assert!(documents.open(a, &first).is_err());
        assert!(documents.create() > b);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_belongs_to_one_document_under_any_path() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let file = real.join("notes.md");
        fs::write(&file, b"old").unwrap();
        let folder = dir.path().join("folder");
        symlink(&real, &folder).unwrap();
        let through_folder = folder.join("notes.md");
        let documents = Documents::default();
        let [a, b] = [documents.create(), documents.create()];
        for path in [&file, &through_folder] {
            documents.grant(path);
        }
        documents.open(a, &file).unwrap();
        documents.keep(a, &file).unwrap();
        // Reopening in the same document is fine; another document is told which has it.
        documents.open(a, &file).unwrap();
        assert!(matches!(
            documents.open(b, &through_folder),
            Err(SaveError::AlreadyOpen { document, .. }) if document == a
        ));
        // Save As onto it from another document is refused and changes nothing.
        assert!(matches!(
            documents.save(b, &through_folder, b"other", SaveMode::Replace),
            Err(SaveError::AlreadyOpen { document, .. }) if document == a
        ));
        assert_eq!(fs::read(&file).unwrap(), b"old");
        // Once the first document closes, the file is free.
        documents.close(a);
        documents.open(b, &through_folder).unwrap();
        documents.keep(b, &through_folder).unwrap();
        documents
            .save(b, &through_folder, b"new", SaveMode::Save)
            .unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
    }

    #[test]
    fn opening_is_checked_again_when_kept_and_saving_claims_new_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"old").unwrap();
        let documents = Documents::default();
        let [a, b, c] = [documents.create(), documents.create(), documents.create()];
        documents.grant(&path);
        // Both read the file before either shows it; only the first to keep it wins.
        documents.open(a, &path).unwrap();
        documents.open(b, &path).unwrap();
        documents.keep(b, &path).unwrap();
        assert!(matches!(
            documents.keep(a, &path),
            Err(SaveError::AlreadyOpen { document, .. }) if document == b
        ));
        assert!(documents.save(a, &path, b"x", SaveMode::Save).is_err());
        // An untitled document saved to a new file now holds that file.
        let created = dir.path().join("new.md");
        documents.grant(&created);
        documents
            .save(c, &created, b"new", SaveMode::Replace)
            .unwrap();
        assert!(matches!(
            documents.open(a, &created),
            Err(SaveError::AlreadyOpen { document, .. }) if document == c
        ));
    }

    #[cfg(unix)]
    #[test]
    fn files_inside_the_open_folder_need_no_grant_and_links_cannot_escape_it() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let outside = dir.path().join("outside");
        fs::create_dir_all(notes.join("sub")).unwrap();
        fs::create_dir(&outside).unwrap();
        let inside = notes.join("sub/a.md");
        fs::write(&inside, b"old").unwrap();
        fs::write(outside.join("secret.md"), b"secret").unwrap();
        symlink(&outside, notes.join("escape")).unwrap();
        let documents = Documents::default();
        let doc = documents.create();
        assert!(
            documents.open(doc, &inside).is_err(),
            "no folder is open yet"
        );
        documents.set_root(Some(Root::new(&notes).unwrap()));
        assert_eq!(documents.open(doc, &inside).unwrap(), b"old");
        documents.keep(doc, &inside).unwrap();
        documents
            .save(doc, &inside, b"new", SaveMode::Save)
            .unwrap();
        assert_eq!(fs::read(&inside).unwrap(), b"new");
        // A new file inside the folder is created on its first save.
        let created = notes.join("new.md");
        let other = documents.create();
        documents.open_with(other, &created, true).unwrap();
        documents.keep(other, &created).unwrap();
        documents
            .save(other, &created, b"first", SaveMode::Save)
            .unwrap();
        assert_eq!(fs::read(&created).unwrap(), b"first");
        // Nothing outside it, through a link or `..`, is reachable.
        let third = documents.create();
        for path in [
            notes.join("escape/secret.md"),
            notes.join("sub/../../outside/secret.md"),
            outside.join("secret.md"),
        ] {
            assert!(documents.open(third, &path).is_err(), "{path:?}");
            assert!(
                documents
                    .save(third, &path, b"x", SaveMode::Replace)
                    .is_err()
            );
        }
        assert_eq!(fs::read(outside.join("secret.md")).unwrap(), b"secret");
        // Closing the folder withdraws access to files no tab has opened, while
        // open tabs can still save.
        documents.set_root(None);
        documents
            .save(doc, &inside, b"later", SaveMode::Save)
            .unwrap();
        documents
            .save(other, &created, b"second", SaveMode::Save)
            .unwrap();
        fs::write(notes.join("unopened.md"), b"x").unwrap();
        assert!(documents.open(third, &notes.join("unopened.md")).is_err());
    }

    #[test]
    fn renames_never_replace_an_entry_that_appeared_after_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.md"), dir.path().join("b.md"));
        fs::write(&a, "mine").unwrap();
        // Another program created b.md between the existence check and the rename.
        fs::write(&b, "theirs").unwrap();
        let error = rename_new(&a, &b, false).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&a).unwrap(), "mine");
        assert_eq!(fs::read_to_string(&b).unwrap(), "theirs");
        // Folders too, including an empty one that a plain rename would replace.
        let (from, to) = (dir.path().join("from"), dir.path().join("to"));
        fs::create_dir(&from).unwrap();
        fs::create_dir(&to).unwrap();
        assert_eq!(
            rename_new(&from, &to, false).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(from.is_dir() && to.is_dir());
        // Through Documents as well, which the file browser uses.
        let documents = Documents::default();
        assert_eq!(
            documents.rename(&a, &b, false).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read_to_string(&b).unwrap(), "theirs");
        // With the name free, it renames.
        let c = dir.path().join("c.md");
        rename_new(&a, &c, false).unwrap();
        assert_eq!(fs::read_to_string(&c).unwrap(), "mine");
        assert!(!a.exists());
    }

    #[test]
    #[cfg(windows)]
    fn a_stale_same_entry_check_cannot_enable_replacement_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("from.md"), dir.path().join("to.md"));
        fs::write(&from, b"mine").unwrap();
        fs::write(&to, b"theirs").unwrap();
        // Even if the earlier check said "same", the native operation must
        // refuse a different entry now at the destination.
        assert!(rename_new(&from, &to, true).is_err());
        assert_eq!(fs::read(&from).unwrap(), b"mine");
        assert_eq!(fs::read(&to).unwrap(), b"theirs");
    }

    #[test]
    fn case_only_renames_work_on_any_drive() {
        let dir = tempfile::tempdir().unwrap();
        let (lower, upper) = (dir.path().join("notes.md"), dir.path().join("Notes.md"));
        fs::write(&lower, "text").unwrap();
        // On a case-insensitive drive Notes.md already names this file.
        let same = fs::symlink_metadata(&upper).is_ok();
        rename_new(&lower, &upper, same).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["Notes.md"]);
    }

    #[test]
    fn renamed_files_and_folders_take_their_documents_along() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(notes.join("old")).unwrap();
        let (a, b) = (notes.join("old/a.md"), notes.join("b.md"));
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(&notes).unwrap()));
        let (first, second, third) = (documents.create(), documents.create(), documents.create());
        for (doc, path) in [(first, &a), (second, &b)] {
            documents.open(doc, path).unwrap();
            documents.keep(doc, path).unwrap();
        }
        let moved = documents
            .rename(&notes.join("old"), &notes.join("new"), false)
            .unwrap();
        let a = notes.join("new/a.md");
        assert_eq!(moved, vec![(first, a.clone())]);
        documents.save(first, &a, b"a2", SaveMode::Save).unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"a2");
        // The new name is the same file, so another tab cannot open it twice.
        assert!(
            matches!(documents.open(third, &a), Err(SaveError::AlreadyOpen { document, .. }) if document == first)
        );
        let c = notes.join("c.md");
        assert_eq!(
            documents.rename(&b, &c, false).unwrap(),
            vec![(second, c.clone())]
        );
        documents.save(second, &c, b"c", SaveMode::Save).unwrap();
        assert!(!b.exists());
        assert_eq!(documents.holding(&notes.join("new")).unwrap(), vec![first]);
        assert_eq!(documents.holding(&c).unwrap(), vec![second]);
        assert!(documents.holding(&notes.join("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_tab_opened_through_a_linked_folder_follows_the_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(notes.join("work")).unwrap();
        std::os::unix::fs::symlink(notes.join("work"), notes.join("linked")).unwrap();
        fs::write(notes.join("work/a.md"), b"a").unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(&notes).unwrap()));
        let doc = documents.create();
        let through = notes.join("linked/a.md");
        documents.open(doc, &through).unwrap();
        documents.keep(doc, &through).unwrap();
        let moved = documents
            .rename(&notes.join("work/a.md"), &notes.join("work/b.md"), false)
            .unwrap();
        let real = fs::canonicalize(notes.join("work/b.md")).unwrap();
        assert_eq!(moved, vec![(doc, real.clone())]);
        documents.save(doc, &real, b"b", SaveMode::Save).unwrap();
        assert_eq!(fs::read(notes.join("work/b.md")).unwrap(), b"b");
        // Renaming the link itself leaves the tab on the real file alone.
        documents
            .rename(&notes.join("linked"), &notes.join("linked2"), false)
            .unwrap();
        documents.save(doc, &real, b"c", SaveMode::Save).unwrap();
    }

    #[test]
    fn native_grants_are_exact_and_missing_files_are_created_only_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");
        let documents = Documents::default();
        let doc = documents.create();
        assert!(documents.open_with(doc, &path, true).is_err());
        documents.granter()(&path);
        assert!(documents.open(doc, &path).is_err());
        assert_eq!(documents.open_with(doc, &path, true).unwrap(), b"");
        assert!(!path.exists());
        documents.keep(doc, &path).unwrap();
        // Another program can create the file while the empty buffer is open.
        fs::write(&path, b"outside").unwrap();
        assert!(matches!(
            documents.save(doc, &path, b"mine", SaveMode::Save),
            Err(SaveError::Conflict { missing: false })
        ));
        assert_eq!(fs::read(&path).unwrap(), b"outside");
        documents
            .save(doc, &path, b"mine", SaveMode::Overwrite)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine");
        let other = dir.path().join("unselected.md");
        assert!(documents.open_with(doc, &other, true).is_err());
        let missing_parent = dir.path().join("missing/new.md");
        documents.granter()(&missing_parent);
        assert!(documents.open_with(doc, &missing_parent, true).is_err());
        let empty = dir.path().join("empty.md");
        documents.granter()(&empty);
        documents.open_with(doc, &empty, true).unwrap();
        documents.keep(doc, &empty).unwrap();
        documents
            .save(doc, &empty, b"first save", SaveMode::Save)
            .unwrap();
        assert_eq!(fs::read(&empty).unwrap(), b"first save");
    }

    #[test]
    fn save_as_replaces_an_existing_destination_once_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.md");
        fs::write(&path, b"existing").unwrap();
        let documents = Documents::default();
        let doc = documents.create();
        let grant = documents.granter();
        grant(&path);
        documents
            .save(doc, &path, b"copy", SaveMode::Replace)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"copy");
        let created = dir.path().join("new.md");
        documents.grant(&created);
        documents
            .save(doc, &created, b"new", SaveMode::Replace)
            .unwrap();
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
        let doc = documents.create();
        for path in [&link, &folder.join("notes.md")] {
            documents.grant(path);
            assert_eq!(documents.open(doc, path).unwrap(), fs::read(&file).unwrap());
            documents.keep(doc, path).unwrap();
            documents.save(doc, path, b"new", SaveMode::Save).unwrap();
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
        assert!(documents.open(doc, &broken).is_err());

        let hard = dir.path().join("hard.md");
        fs::hard_link(&file, &hard).unwrap();
        documents.grant(&hard);
        assert_eq!(documents.open(doc, &hard).unwrap(), b"old");
        documents.keep(doc, &hard).unwrap();
        assert!(documents.save(doc, &hard, b"bad", SaveMode::Save).is_err());
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
