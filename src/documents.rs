use serde::Serialize;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri_plugin_fs::FsExt;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum SaveError {
    Conflict,
    Io(String),
}
impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

// Never replace a symlink itself or silently break a hard link. The user can
// Save As to a regular file instead. Reject directories and special files too.
fn metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.is_file() {
                return Err(io::Error::other(
                    "Choose a regular file; symbolic links and special files are not supported for saving.",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() > 1 {
                    return Err(io::Error::other(
                        "This file has hard links. Use Save As to avoid breaking them.",
                    ));
                }
            }
            Ok(Some(meta))
        }
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
    if snapshot(path)?.as_deref() != expected {
        return Err(SaveError::Conflict);
    }
    let original = metadata(path)?;
    if original
        .as_ref()
        .is_some_and(|meta| meta.permissions().readonly())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The document is read-only.",
        )
        .into());
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".textgate-")
        .tempfile_in(parent)?;
    write(temporary.as_file_mut())?;
    if let Some(meta) = original {
        temporary.as_file().set_permissions(meta.permissions())?;
    }
    temporary.as_file().sync_all()?;
    // Recheck after writing the temporary file. This is conflict detection,
    // not a filesystem-wide lock against other editors racing the final rename.
    if snapshot(path)?.as_deref() != expected {
        return Err(SaveError::Conflict);
    }
    let persisted = if expected.is_none() {
        temporary.persist_noclobber(path)
    } else {
        temporary.persist(path)
    };
    persisted.map_err(|error| SaveError::from(error.error))?;
    // Best effort directory durability: some filesystems cannot sync directories.
    // A failure here must not report an unsuccessful save after replacement.
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn allowed(app: &tauri::AppHandle, path: &Path) -> Result<(), SaveError> {
    if !path.is_absolute() || !app.fs_scope().is_allowed(path) {
        return Err(SaveError::Io(
            "Choose the file through Open or Save As first.".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn document_snapshot(
    app: tauri::AppHandle,
    path: PathBuf,
) -> Result<Option<Vec<u8>>, SaveError> {
    allowed(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(&path).map_err(SaveError::from))
        .await
        .map_err(|error| SaveError::Io(error.to_string()))?
}

#[tauri::command]
pub async fn save_document(
    app: tauri::AppHandle,
    path: PathBuf,
    contents: String,
    expected: Option<Vec<u8>>,
) -> Result<(), SaveError> {
    allowed(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        save(&path, contents.as_bytes(), expected.as_deref())
    })
    .await
    .map_err(|error| SaveError::Io(error.to_string()))?
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
            Err(SaveError::Conflict)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbfother\r\n");
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            save(&path, b"edited", Some(original)),
            Err(SaveError::Conflict)
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
            Err(SaveError::Conflict)
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
        assert!(matches!(result, Err(SaveError::Io(_))));
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
        assert!(matches!(result, Err(SaveError::Conflict)));
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_permissions_and_rejects_links_and_readonly_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        save(&path, b"new", Some(b"old")).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let link = dir.path().join("link.md");
        symlink(&path, &link).unwrap();
        assert!(save(&link, b"bad", Some(b"new")).is_err());
        fs::remove_file(&link).unwrap();
        fs::hard_link(&path, &link).unwrap();
        assert!(save(&path, b"bad", Some(b"new")).is_err());
        fs::remove_file(&link).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        assert!(save(&path, b"bad", Some(b"new")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }
}
