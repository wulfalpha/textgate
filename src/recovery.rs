//! Private, atomic recovery checkpoints. No command accepts a recovery path or
//! a document baseline from the webview: those come from native document slots.
use crate::documents::{DocumentId, Documents, SaveError, Version};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

const VERSION: u32 = 1;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TABS: usize = 512;

#[derive(Default)]
pub struct Recovery {
    // Serializes restore/checkpoint I/O and prevents writes before a successful
    // read. A corrupt checkpoint must not be silently replaced on startup.
    pub(crate) ready: Mutex<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointTab {
    pub(crate) document: DocumentId,
    pub(crate) contents: String,
    pub(crate) dirty: bool,
    pub(crate) anchor: usize,
    pub(crate) head: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub(crate) tabs: Vec<CheckpointTab>,
    pub(crate) active: usize,
    pub(crate) closed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredTab {
    pub(crate) original: Option<Version>,
    pub(crate) contents: String,
    pub(crate) dirty: bool,
    pub(crate) anchor: usize,
    pub(crate) head: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Session {
    pub(crate) version: u32,
    pub(crate) tabs: Vec<StoredTab>,
    pub(crate) active: usize,
    pub(crate) closed: bool,
}

#[derive(Serialize)]
pub struct RestoredTab {
    document: DocumentId,
    path: Option<String>,
    contents: String,
    dirty: bool,
    anchor: usize,
    head: usize,
}

#[derive(Default, Serialize)]
pub struct RestoredSession {
    tabs: Vec<RestoredTab>,
    active: usize,
    interrupted: bool,
    warnings: Vec<String>,
}

fn message(error: SaveError) -> String {
    match error {
        SaveError::Io { message } | SaveError::AlreadyOpen { message, .. } => message,
        SaveError::Conflict { .. } => "The file changed while restoring it.".into(),
    }
}

pub(crate) fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("recovery/session.json"))
        .map_err(|error| error.to_string())
}

pub(crate) fn validate(session: &Session) -> Result<(), String> {
    if session.version != VERSION {
        return Err("This recovery file was written by an unsupported Textgate version.".into());
    }
    if session.tabs.len() > MAX_TABS
        || (!session.tabs.is_empty() && session.active >= session.tabs.len())
    {
        return Err("The recovery file has an invalid tab list.".into());
    }
    if session.tabs.iter().any(|tab| {
        tab.original
            .as_ref()
            .is_some_and(|(path, _)| !path.is_absolute() || path.to_str().is_none())
    }) {
        return Err("The recovery file contains an invalid document path.".into());
    }
    Ok(())
}

fn load(path: &Path) -> Result<Option<Session>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Recovery data exceeds the 64 MiB checkpoint limit.".into());
    }
    let session = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Recovery data could not be read: {error}"))?;
    validate(&session)?;
    Ok(Some(session))
}

pub(crate) fn store(path: &Path, session: &Session) -> Result<(), String> {
    store_with(path, session, |file, bytes| file.write_all(bytes))
}

fn store_with(
    path: &Path,
    session: &Session,
    write: impl FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
) -> Result<(), String> {
    validate(session)?;
    let bytes = serde_json::to_vec(session).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Recovery data exceeds the 64 MiB checkpoint limit. Save your documents to keep their latest edits.".into());
    }
    let directory = path.parent().ok_or("No recovery directory is available.")?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|error| error.to_string())?;
    let mut file = tempfile::Builder::new()
        .prefix(".session-")
        .tempfile_in(directory)
        .map_err(|error| error.to_string())?;
    write(file.as_file_mut(), &bytes).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path)
        .map_err(|error| error.error.to_string())?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(directory) {
        let _ = directory.sync_all();
    }
    Ok(())
}

pub(crate) fn capture(documents: &Documents, checkpoint: Checkpoint) -> Result<Session, String> {
    if checkpoint.tabs.len() > MAX_TABS
        || (!checkpoint.tabs.is_empty() && checkpoint.active >= checkpoint.tabs.len())
    {
        return Err("Recovery supports at most 512 tabs and requires a valid active tab.".into());
    }
    let ids: Vec<_> = checkpoint.tabs.iter().map(|tab| tab.document).collect();
    let originals = documents.recovery_baselines(&ids).map_err(message)?;
    let mut tabs = Vec::new();
    let mut active = 0;
    for (index, (tab, original)) in checkpoint.tabs.into_iter().zip(originals).enumerate() {
        // A deliberate normal quit discards unnamed drafts. Named tabs retain
        // only a path and whether the file had existed, never draft text.
        if checkpoint.closed && original.is_none() {
            continue;
        }
        if index == checkpoint.active {
            active = tabs.len();
        }
        let original = if checkpoint.closed {
            original.map(|(path, bytes)| (path, bytes.map(|_| Vec::new())))
        } else {
            original
        };
        tabs.push(StoredTab {
            original,
            contents: if checkpoint.closed {
                String::new()
            } else {
                tab.contents
            },
            dirty: !checkpoint.closed && tab.dirty,
            anchor: tab.anchor,
            head: tab.head,
        });
    }
    Ok(Session {
        version: VERSION,
        tabs,
        active,
        closed: checkpoint.closed,
    })
}

fn restore(documents: &Documents, session: Session) -> Result<RestoredSession, String> {
    validate(&session)?;
    let mut restored = RestoredSession {
        interrupted: !session.closed,
        ..Default::default()
    };
    for (index, tab) in session.tabs.into_iter().enumerate() {
        let mut dirty = !session.closed && tab.dirty;
        let result = documents.restore_recovery(tab.original.clone(), &tab.contents, dirty);
        let (mut document, mut path, bytes) = match result {
            Ok(open) => open,
            Err(SaveError::AlreadyOpen { .. }) if dirty => {
                restored.warnings.push("A duplicate recovered file was opened as Untitled to preserve its unsaved text.".into());
                documents
                    .restore_recovery(None, &tab.contents, true)
                    .map_err(message)?
            }
            Err(SaveError::AlreadyOpen { .. }) => {
                restored
                    .warnings
                    .push("A duplicate saved tab was skipped during recovery.".into());
                continue;
            }
            Err(error) if !dirty => {
                let path = tab
                    .original
                    .as_ref()
                    .map(|(path, _)| path.display().to_string())
                    .unwrap_or_else(|| "Untitled".into());
                restored
                    .warnings
                    .push(format!("Could not reopen {path}: {}", message(error)));
                if session.closed {
                    continue;
                }
                // If a clean file disappeared just before a crash (including
                // during Trash), its cached text is still recoverable.
                dirty = true;
                documents
                    .restore_recovery(tab.original.clone(), &tab.contents, true)
                    .map_err(message)?
            }
            Err(error) => return Err(message(error)),
        };
        let contents = match String::from_utf8(bytes) {
            Ok(contents) => contents,
            Err(_) => {
                documents.close(document);
                restored.warnings.push(
                    "A saved document could not be reopened because it is not valid UTF-8.".into(),
                );
                if session.closed {
                    continue;
                }
                dirty = true;
                let recovered = documents
                    .restore_recovery(tab.original.clone(), &tab.contents, true)
                    .map_err(message)?;
                document = recovered.0;
                path = recovered.1;
                tab.contents.clone()
            }
        };
        if index == session.active {
            restored.active = restored.tabs.len();
        }
        restored.tabs.push(RestoredTab {
            document,
            path: path.map(|path| path.to_string_lossy().into_owned()),
            contents,
            dirty,
            anchor: tab.anchor,
            head: tab.head,
        });
    }
    Ok(restored)
}

#[tauri::command]
pub async fn restore_session(app: tauri::AppHandle) -> Result<RestoredSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recovery = app.state::<Recovery>();
        let mut ready = recovery.ready.lock().unwrap();
        if *ready {
            return Ok(RestoredSession::default());
        }
        let result = match load(&session_path(&app)?)? {
            Some(session) => {
                let (session, warnings) = crate::rename_links::reconcile(&app, session);
                let mut restored = restore(&app.state::<Documents>(), session)?;
                restored.warnings.extend(warnings);
                restored
            }
            None => match crate::rename_links::recovery_seed(&app) {
                Ok(Some(session)) => {
                    let (session, warnings) = crate::rename_links::reconcile(&app, session);
                    let mut restored = restore(&app.state::<Documents>(), session)?;
                    restored.warnings.extend(warnings);
                    restored
                }
                Ok(None) => RestoredSession::default(),
                Err(error) => RestoredSession {
                    warnings: vec![error],
                    ..Default::default()
                },
            },
        };
        *ready = true;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn checkpoint_session(
    app: tauri::AppHandle,
    checkpoint: Checkpoint,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recovery = app.state::<Recovery>();
        let ready = recovery.ready.lock().unwrap();
        if !*ready {
            return Err(
                "The previous recovery data has not been restored; it was left untouched.".into(),
            );
        }
        let session = capture(&app.state::<Documents>(), checkpoint)?;
        store(&session_path(&app)?, &session)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(document: DocumentId, contents: &str, dirty: bool) -> CheckpointTab {
        CheckpointTab {
            document,
            contents: contents.into(),
            dirty,
            anchor: 2,
            head: 4,
        }
    }
    fn named(documents: &Documents, path: &Path) -> DocumentId {
        documents
            .restore_recovery(Some((path.to_path_buf(), None)), "", false)
            .unwrap()
            .0
    }

    #[test]
    fn duplicate_clean_tabs_do_not_abort_restoring_other_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "saved").unwrap();
        let documents = Documents::default();
        let file = named(&documents, &path);
        let draft = documents.restore_recovery(None, "", false).unwrap().0;
        let session = capture(
            &documents,
            Checkpoint {
                tabs: vec![
                    tab(file, "saved", false),
                    tab(file, "saved", false),
                    tab(draft, "unsaved", true),
                ],
                active: 2,
                closed: false,
            },
        )
        .unwrap();
        let restored = restore(&Documents::default(), session).unwrap();
        assert_eq!(restored.tabs.len(), 2);
        assert_eq!(restored.active, 1);
        assert_eq!(restored.tabs[1].contents, "unsaved");
        assert!(restored.tabs[1].dirty);
        assert_eq!(restored.warnings.len(), 1);
    }

    #[test]
    fn checkpoint_round_trip_preserves_drafts_order_selection_and_bom_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"original\r\n").unwrap();
        let documents = Documents::default();
        let file = named(&documents, &path);
        let untitled = documents.restore_recovery(None, "", false).unwrap().0;
        let draft = "\u{feff}# Café\r\n\nlast\rno final newline";
        let session = capture(
            &documents,
            Checkpoint {
                tabs: vec![tab(file, draft, true), tab(untitled, "new draft", true)],
                active: 1,
                closed: false,
            },
        )
        .unwrap();
        let cache = dir.path().join("recovery/session.json");
        store(&cache, &session).unwrap();
        let restored = restore(&Documents::default(), load(&cache).unwrap().unwrap()).unwrap();
        assert!(restored.interrupted);
        assert_eq!(restored.active, 1);
        assert_eq!(restored.tabs.len(), 2);
        assert_eq!(restored.tabs[0].contents.as_bytes(), draft.as_bytes());
        assert_eq!(restored.tabs[0].path.as_deref(), path.to_str());
        assert!(restored.tabs.iter().all(|tab| tab.dirty));
        assert_eq!((restored.tabs[0].anchor, restored.tabs[0].head), (2, 4));
        assert_eq!(restored.tabs[1].contents, "new draft");
        assert_eq!(restored.tabs[1].path, None);
        assert_eq!(
            fs::read(&path).unwrap(),
            b"original\r\n",
            "checkpointing and restoration never save source files"
        );
    }

    #[test]
    fn a_clean_quit_removes_discarded_text_and_reopens_named_files_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, b"saved text").unwrap();
        let documents = Documents::default();
        let file = named(&documents, &path);
        let untitled = documents.restore_recovery(None, "", false).unwrap().0;
        let session = capture(
            &documents,
            Checkpoint {
                tabs: vec![
                    tab(untitled, "secret unnamed", true),
                    tab(file, "secret named", true),
                ],
                active: 1,
                closed: true,
            },
        )
        .unwrap();
        let encoded = serde_json::to_string(&session).unwrap();
        assert!(!encoded.contains("secret"));
        assert_eq!(session.tabs.len(), 1);
        assert_eq!(session.active, 0);
        assert_eq!(
            session.tabs[0].original.as_ref().unwrap().1,
            Some(Vec::new())
        );
        fs::write(&path, b"changed after quit").unwrap();
        let restored = restore(&Documents::default(), session).unwrap();
        assert!(!restored.interrupted);
        assert_eq!(restored.tabs[0].contents, "changed after quit");
        assert!(!restored.tabs[0].dirty);
        let empty = capture(
            &documents,
            Checkpoint {
                tabs: vec![],
                active: 0,
                closed: false,
            },
        )
        .unwrap();
        assert!(
            empty.tabs.is_empty(),
            "closing tabs can replace the previous session with an empty checkpoint"
        );
    }

    #[test]
    fn failed_writes_leave_the_previous_private_checkpoint_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recovery/session.json");
        let session = Session {
            version: VERSION,
            tabs: vec![],
            active: 0,
            closed: false,
        };
        store(&path, &session).unwrap();
        let before = fs::read(&path).unwrap();
        let failure = store_with(&path, &session, |file, _| {
            file.write_all(b"partial write")?;
            Err(io::Error::other("simulated disk-full error"))
        });
        assert!(failure.is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn corrupt_unknown_relative_and_oversized_data_is_not_modified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        for bytes in [
            b"{broken".to_vec(),
            serde_json::to_vec(&Session {
                version: 99,
                tabs: vec![],
                active: 0,
                closed: false,
            })
            .unwrap(),
            serde_json::to_vec(&Session {
                version: VERSION,
                tabs: vec![StoredTab {
                    original: Some(("relative.md".into(), None)),
                    contents: "draft".into(),
                    dirty: true,
                    anchor: 0,
                    head: 0,
                }],
                active: 0,
                closed: false,
            })
            .unwrap(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(load(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(load(&path).unwrap_err().contains("64 MiB"));
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_BYTES + 1);
    }

    #[test]
    fn unknown_handles_cannot_nominate_recovery_paths_and_missing_clean_tabs_do_not_block_drafts() {
        let documents = Documents::default();
        assert!(
            capture(
                &documents,
                Checkpoint {
                    tabs: vec![tab(999, "draft", true)],
                    active: 0,
                    closed: false
                }
            )
            .is_err()
        );
        assert!(serde_json::from_str::<CheckpointTab>(r#"{"document":1,"contents":"x","dirty":true,"anchor":0,"head":0,"path":"/arbitrary"}"#).is_err());
        let dir = tempfile::tempdir().unwrap();
        let session = Session {
            version: VERSION,
            tabs: vec![
                StoredTab {
                    original: Some((dir.path().join("gone.md"), Some(vec![]))),
                    contents: String::new(),
                    dirty: false,
                    anchor: 0,
                    head: 0,
                },
                StoredTab {
                    original: None,
                    contents: "keep this".into(),
                    dirty: true,
                    anchor: 0,
                    head: 0,
                },
            ],
            active: 1,
            closed: false,
        };
        let restored = restore(&documents, session).unwrap();
        assert_eq!(restored.tabs.len(), 2);
        assert!(
            restored.tabs[0].dirty,
            "missing files in an interrupted session retain cached text"
        );
        assert_eq!(restored.tabs[1].contents, "keep this");
        assert_eq!(restored.active, 1);
        assert_eq!(restored.warnings.len(), 1);
    }
}
