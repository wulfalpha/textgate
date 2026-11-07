//! Link clicks reuse existing grants; document content cannot grant paths.
use crate::documents::{DocumentId, Documents};
use std::path::{Path, PathBuf};
use tauri::Manager;

fn resolve(
    documents: &Documents,
    document: Option<DocumentId>,
    link: &str,
    wiki: bool,
) -> Result<PathBuf, String> {
    resolve_scoped_file(documents, document, link, wiki, &["md", "markdown", "txt"])
}

pub(crate) fn resolve_scoped_file(
    documents: &Documents,
    document: Option<DocumentId>,
    link: &str,
    wiki: bool,
    extensions: &[&str],
) -> Result<PathBuf, String> {
    if link.is_empty()
        || link.len() > 4096
        || link.contains(['\\', ':', '\0'])
        || Path::new(link).is_absolute()
    {
        return Err("Use a relative file path.".into());
    }
    let root = documents.root();
    let original = match document {
        Some(id) => documents
            .document_path(id)
            .map_err(|_| "The source tab is no longer open.")?,
        None => None,
    };
    let base = original
        .as_ref()
        .and_then(|path| path.parent())
        .or_else(|| root.as_ref().map(|root| root.link_base()));
    let Some(base) = base else {
        return Err("Save this note or use Open Folder before following relative links.".into());
    };
    let mut relative = PathBuf::from(link);
    if wiki && relative.extension().is_none() {
        relative.set_extension("md");
    }
    if !relative
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
    {
        return Err(format!(
            "Supported file extensions: {}.",
            extensions.join(", ")
        ));
    }
    let mut candidates = vec![base.join(&relative)];
    if wiki && let Some(root) = &root {
        candidates.push(root.link_base().join(&relative));
    }
    let mut denied = false;
    for candidate in candidates {
        let Ok(real) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        let real_allowed =
            root.as_ref().is_some_and(|root| root.contains(&real)) || documents.chosen(&real);
        let granted = if real_allowed {
            None
        } else {
            documents.granted_path_for(&real)
        };
        if !real_allowed && granted.is_none() {
            denied = true;
            continue;
        }
        if !real.is_file() {
            continue;
        }
        return Ok(granted.unwrap_or(real));
    }
    // `[[202611071530]]` or `[[202611071530 Old title]]` finds the note with
    // that ID anywhere in the workspace, so a changed title does not break it.
    if wiki
        && let Some(root) = &root
        && let Some(id) = crate::notes::link_id(link)
    {
        return crate::notes::resolve_id(root, id);
    }
    Err(if denied {
        "This file is outside the open folder. Choose its folder with Open Folder first."
    } else {
        "Linked file not found. No file was created."
    }
    .into())
}

#[tauri::command]
pub async fn resolve_note_link(
    app: tauri::AppHandle,
    document: Option<DocumentId>,
    link: String,
    wiki: bool,
) -> Result<PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve(&app.state::<Documents>(), document, &link, wiki)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Root;
    use std::fs;

    #[test]
    fn relative_and_wiki_links_use_source_folder_then_workspace_without_creating_files() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("notes");
        fs::create_dir(&folder).unwrap();
        let source = folder.join("source.md");
        fs::write(&source, "draft").unwrap();
        fs::write(folder.join("Target.md"), "local").unwrap();
        fs::write(dir.path().join("Target.md"), "root").unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(dir.path()).unwrap()));
        let id = documents
            .restore_recovery(Some((source, None)), "", false)
            .unwrap()
            .0;
        assert_eq!(
            resolve(&documents, Some(id), "Target", true).unwrap(),
            fs::canonicalize(folder.join("Target.md")).unwrap()
        );
        fs::remove_file(folder.join("Target.md")).unwrap();
        assert_eq!(
            resolve(&documents, Some(id), "Target", true).unwrap(),
            fs::canonicalize(dir.path().join("Target.md")).unwrap()
        );
        assert!(resolve(&documents, Some(id), "Target", false).is_err());
        assert!(
            resolve(&documents, None, "missing.md", false)
                .unwrap_err()
                .contains("not found")
        );
        assert!(!dir.path().join("missing.md").exists());
        assert!(resolve(&documents, Some(999), "Target", true).is_err());
    }

    #[test]
    fn wiki_links_with_an_id_find_the_note_anywhere_after_a_title_change() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("archive")).unwrap();
        let note = dir.path().join("archive/202611071530 New title.md");
        fs::write(&note, "").unwrap();
        fs::write(dir.path().join("202611071531.md"), "").unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(dir.path()).unwrap()));
        let real = fs::canonicalize(&note).unwrap();
        assert_eq!(
            resolve(&documents, None, "202611071530", true).unwrap(),
            real
        );
        assert_eq!(
            resolve(&documents, None, "202611071530 Old title", true).unwrap(),
            real
        );
        // An exact name next to the source still wins.
        assert_eq!(
            resolve(&documents, None, "202611071531", true).unwrap(),
            fs::canonicalize(dir.path().join("202611071531.md")).unwrap()
        );
        assert!(resolve(&documents, None, "202611071530", false).is_err());
        assert!(
            resolve(&documents, None, "202611079999", true)
                .unwrap_err()
                .contains("No note with ID")
        );
    }

    #[test]
    fn links_do_not_grant_outside_files_or_accept_absolute_paths_and_schemes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("notes");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("outside.md"), "private").unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(&root).unwrap()));
        assert!(
            resolve(&documents, None, "../outside.md", false)
                .unwrap_err()
                .contains("outside")
        );
        for link in [
            "/etc/notes.md",
            "C:\\notes.md",
            "https://example.com/a.md",
            "//server/notes.md",
            "script.exe",
            "",
            "../outside.md\0",
        ] {
            assert!(resolve(&documents, None, link, false).is_err(), "{link}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("outside.md"), root.join("escape.md"))
                .unwrap();
            assert!(resolve(&documents, None, "escape.md", false).is_err());
        }
    }
}
