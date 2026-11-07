//! Missing-link creation is separately confirmed and revalidated; lookup errors
//! such as ambiguity or unreadable folders never authorize creating a note.
use crate::{
    documents::{DocumentId, Documents},
    note_links, notes,
    workspace::{EXTENSIONS, Root, checked_name},
};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    root: String,
    path: String,
    title: String,
    can_id: bool,
    filename_error: Option<String>,
    #[serde(skip)]
    scope: Root,
}

fn prepare(
    documents: &Documents,
    document: Option<DocumentId>,
    link: &str,
    wiki: bool,
) -> Result<Proposal, String> {
    let root = documents
        .root()
        .ok_or("Open a folder before creating linked notes.")?;
    if !root.contains(root.link_base()) {
        return Err(
            "The open folder moved or its link target changed. Choose Open Folder again.".into(),
        );
    }
    // Validate the navigation result again, rather than accepting a frontend
    // assertion that a path is missing.
    match note_links::resolve(documents, document, link, wiki) {
        Ok(_) => return Err("The linked note already exists. Follow the link again.".into()),
        Err(error) => {
            let missing_id = wiki
                && notes::link_id(link).is_some_and(|id| {
                    error == format!("No note with ID {id} was found. No file was created.")
                });
            if error != "Linked file not found. No file was created." && !missing_id {
                return Err(error);
            }
        }
    }
    let original = document
        .map(|id| documents.document_path(id))
        .transpose()
        .map_err(|_| "The source tab is no longer open.")?
        .flatten();
    let base = original
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or(root.link_base());
    let mut relative = PathBuf::from(link);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Create notes using a relative path inside the open folder.".into());
    }
    if wiki && relative.extension().is_none() {
        relative.set_extension("md");
    }
    // An ID plus a title containing punctuation is still an ID link.
    if wiki && notes::link_id(link).is_some() {
        relative = PathBuf::from(format!("{link}.md"));
    }
    if !relative
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| EXTENSIONS.iter().any(|ext| s.eq_ignore_ascii_case(ext)))
    {
        return Err("New linked notes must end in .md, .markdown or .txt.".into());
    }
    for component in relative.components() {
        if let Component::Normal(name) = component {
            let name = name.to_str().ok_or("The name is not valid Unicode.")?;
            if checked_name(name)? != name {
                return Err("Names cannot have leading or trailing spaces.".into());
            }
        }
    }
    let path = if wiki && notes::link_id(link).is_some() {
        root.link_base().join(&relative)
    } else {
        base.join(&relative)
    };
    // Check both navigation candidates: a dangling symlink or permission error
    // is not a missing file, even if canonicalization failed during lookup.
    let candidates = if wiki {
        vec![base.join(&relative), root.link_base().join(&relative)]
    } else {
        vec![path.clone()]
    };
    for candidate in candidates {
        match fs::symlink_metadata(&candidate) {
            Ok(_) => return Err("The linked path already exists or cannot be opened.".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let can_id = wiki
        && notes::link_id(link).is_none()
        && !link.contains('/')
        && Path::new(link).extension().is_none();
    let parent = path.parent().ok_or("Choose a note filename.")?;
    let filename_error = if !parent.is_dir() || !root.contains(parent) || !root.contains(&path) {
        Some("The link's filename would be outside the open folder or in a missing folder. Only an ID note in the open folder can be created here.".to_owned())
    } else {
        None
    };
    if !can_id && filename_error.is_some() {
        return Err("The destination folder must already exist inside the open folder. Create folders separately.".into());
    }
    let title = if wiki {
        notes::link_id(link)
            .and_then(|id| link.strip_prefix(id))
            .unwrap_or(link)
            .trim()
            .to_owned()
    } else {
        String::new()
    };
    Ok(Proposal {
        root: root.link_base().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        title,
        can_id,
        filename_error,
        scope: root,
    })
}

fn create(documents: &Documents, request: &Creation) -> Result<String, String> {
    let proposal = prepare(documents, request.document, &request.link, request.wiki)?;
    if proposal.root != request.expected_root {
        return Err("The open folder changed. Follow the link again.".into());
    }
    if proposal.path != request.expected_path {
        return Err("The destination changed. Cancel and follow the link again.".into());
    }
    // Retain the original native grant. Rebuilding Root from the path would
    // authorize a newly retargeted workspace symlink.
    let root = &proposal.scope;
    let path = if request.with_id {
        if !proposal.can_id {
            return Err("This link requires its own filename or ID.".into());
        }
        notes::create(root, &proposal.title, &request.ids)?
    } else {
        if let Some(error) = proposal.filename_error {
            return Err(error);
        }
        let path = PathBuf::from(&proposal.path);
        if !root.contains(&path) {
            return Err("The destination is no longer inside the open folder.".into());
        }
        // Exclusive creation also rejects a collision after the preview.
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        path
    };
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn prepare_missing_note(
    app: tauri::AppHandle,
    document: Option<DocumentId>,
    link: String,
    wiki: bool,
) -> Result<Proposal, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare(&app.state::<Documents>(), document, &link, wiki)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Creation {
    document: Option<DocumentId>,
    link: String,
    wiki: bool,
    expected_root: String,
    expected_path: String,
    with_id: bool,
    ids: Vec<String>,
}

#[tauri::command]
pub async fn create_missing_note(
    app: tauri::AppHandle,
    request: Creation,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create(&app.state::<Documents>(), &request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    // Exercise the same confirmed request as IPC, with a freshly prepared path.
    fn create(
        documents: &Documents,
        document: Option<DocumentId>,
        link: &str,
        wiki: bool,
        expected_root: &str,
        with_id: bool,
        ids: &[String],
    ) -> Result<String, String> {
        let proposal = prepare(documents, document, link, wiki)?;
        super::create(
            documents,
            &Creation {
                document,
                link: link.into(),
                wiki,
                expected_root: expected_root.into(),
                expected_path: proposal.path,
                with_id,
                ids: ids.to_vec(),
            },
        )
    }
    fn setup(dir: &Path) -> Documents {
        let docs = Documents::default();
        docs.set_root(Some(Root::new(dir).unwrap()));
        docs
    }
    #[test]
    fn explicit_paths_are_preserved_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        fs::create_dir(dir.path().join("notes")).unwrap();
        let root = dir.path().to_str().unwrap();
        let plan = prepare(&docs, None, "notes/Next note.md", false).unwrap();
        assert!(!Path::new(&plan.path).exists());
        assert_eq!(
            create(&docs, None, "notes/Next note.md", false, root, false, &[]).unwrap(),
            plan.path
        );
        fs::write(&plan.path, "keep").unwrap();
        assert!(create(&docs, None, "notes/Next note.md", false, root, false, &[]).is_err());
        assert_eq!(fs::read_to_string(plan.path).unwrap(), "keep");
        assert!(prepare(&docs, None, "missing/Next.md", false).is_err());
        assert!(prepare(&docs, None, "../escape.md", false).is_err());
    }
    #[test]
    fn confirmed_requests_reject_stale_destinations_collisions_and_workspace_switches() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let proposal = prepare(&docs, None, "Next.md", false).unwrap();
        let mut request = Creation {
            document: None,
            link: "Next.md".into(),
            wiki: false,
            expected_root: proposal.root,
            expected_path: "stale destination".into(),
            with_id: false,
            ids: vec![],
        };
        assert!(
            super::create(&docs, &request)
                .unwrap_err()
                .contains("destination changed")
        );
        assert!(!dir.path().join("Next.md").exists());
        request.expected_path = proposal.path;
        fs::write(&request.expected_path, "outside edit").unwrap();
        assert!(super::create(&docs, &request).is_err());
        assert_eq!(
            fs::read_to_string(&request.expected_path).unwrap(),
            "outside edit"
        );
        docs.set_root(Some(Root::new(other.path()).unwrap()));
        assert!(
            super::create(&docs, &request)
                .unwrap_err()
                .contains("open folder changed")
        );
        assert!(!other.path().join("Next.md").exists());
    }
    #[test]
    fn a_source_outside_the_workspace_can_create_an_id_note_but_not_a_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let source = outside.path().join("source.md");
        fs::write(&source, "[[Next]]").unwrap();
        let document = docs
            .restore_recovery(Some((source, None)), "[[Next]]", false)
            .unwrap()
            .0;
        let proposal = prepare(&docs, Some(document), "Next", true).unwrap();
        assert!(proposal.can_id);
        assert!(proposal.filename_error.is_some());
        let root = dir.path().to_str().unwrap();
        assert!(create(&docs, Some(document), "Next", true, root, false, &[]).is_err());
        let created = create(
            &docs,
            Some(document),
            "Next",
            true,
            root,
            true,
            &["202611071530".into()],
        )
        .unwrap();
        assert_eq!(Path::new(&created).parent(), Some(dir.path()));
        assert!(!outside.path().join("Next.md").exists());
        assert!(prepare(&docs, Some(document), "Other.md", false).is_err());
    }
    #[test]
    fn wiki_creation_supports_ids_or_the_original_name() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let root = dir.path().to_str().unwrap();
        assert!(prepare(&docs, None, "Next note", true).unwrap().can_id);
        let path = create(
            &docs,
            None,
            "Next note",
            true,
            root,
            true,
            &["202611071530".into()],
        )
        .unwrap();
        assert!(path.ends_with("202611071530 Next note.md"));
        assert_eq!(fs::read_to_string(path).unwrap(), "# Next note\n\n");
        assert!(
            create(&docs, None, "Plain", true, root, false, &[])
                .unwrap()
                .ends_with("Plain.md")
        );
        assert!(
            create(&docs, None, "202611071531 Title", true, root, false, &[])
                .unwrap()
                .ends_with("202611071531 Title.md")
        );
        assert!(prepare(&docs, None, "202611071531", true).is_err());
    }
    #[test]
    fn ambiguity_and_changed_workspace_block_creation() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("202611071530 A.md"), "").unwrap();
        fs::write(dir.path().join("202611071530 B.md"), "").unwrap();
        assert!(
            prepare(&docs, None, "202611071530", true)
                .unwrap_err()
                .contains("2 notes share")
        );
        assert!(
            create(
                &docs,
                None,
                "Next",
                true,
                "other",
                true,
                &["202611071531".into()]
            )
            .is_err()
        );
        assert_eq!(fs::read_dir(root).unwrap().count(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn a_retargeted_workspace_link_does_not_authorize_creation_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        let outside = dir.path().join("outside");
        let link = dir.path().join("workspace");
        fs::create_dir(&original).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&original, &link).unwrap();
        let docs = setup(&link);
        let root = link.to_str().unwrap();
        assert!(prepare(&docs, None, "Next", true).is_ok());
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            create(
                &docs,
                None,
                "Next",
                true,
                root,
                true,
                &["202611071530".into()]
            )
            .is_err()
        );
        assert!(notes::create(&docs.root().unwrap(), "Other", &["202611071531".into()]).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&original).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn linked_folders_outside_scope_and_dangling_links_are_not_missing_notes() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("absent"), dir.path().join("broken.md"))
            .unwrap();
        assert!(prepare(&docs, None, "outside/new.md", false).is_err());
        assert!(prepare(&docs, None, "broken.md", false).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
