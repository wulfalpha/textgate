//! Filename/ID search over the shared, scope-checked note inventory. No note
//! contents are read, and a result does not grant a new filesystem capability.
use crate::{
    backlinks,
    documents::Documents,
    workspace::{self, Root},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct Entry {
    path: String,
    label: String,
}
#[derive(Debug, Serialize)]
pub struct Results {
    entries: Vec<Entry>,
    warnings: Vec<String>,
}

fn rank(label: &str, ids: &[String], query: &str) -> Option<u8> {
    let label = label.to_lowercase();
    let name = label.rsplit('/').next().unwrap_or(&label);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    if query.is_empty() {
        return Some(5);
    }
    if !query
        .split_whitespace()
        .all(|word| label.contains(word) || ids.iter().any(|id| id.contains(word)))
    {
        return None;
    }
    Some(
        if name == query || stem == query || ids.iter().any(|id| id == query) {
            0
        } else if name.starts_with(query) || ids.iter().any(|id| id.starts_with(query)) {
            1
        } else if name.contains(query) {
            2
        } else {
            3
        },
    )
}

fn search(root: &Root, query: &str, limit: usize) -> Result<Results, String> {
    if query.chars().count() > 256 {
        return Err("Search is limited to 256 characters.".into());
    }
    let query = query.trim().to_lowercase();
    let scan = backlinks::inventory(root, limit);
    let mut warnings = scan.warnings;
    if !scan.complete && warnings.is_empty() {
        warnings.push("Workspace inventory is incomplete.".into());
    }
    let mut ids: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
    for (id, paths) in scan.ids {
        for path in paths {
            ids.entry(path).or_default().push(id.clone());
        }
    }
    let mut matches = Vec::new();
    for path in scan.paths {
        let label = workspace::relative_label(root, &path);
        if let Some(score) = rank(&label, ids.get(&path).map_or(&[], Vec::as_slice), &query) {
            matches.push((score, label.to_lowercase(), path, label));
        }
    }
    matches.sort_by(|a, b| (&a.0, &a.1, &a.2).cmp(&(&b.0, &b.1, &b.2)));
    if matches.len() > 100 {
        warnings.push("Showing the first 100 matches. Narrow the search to see others.".into());
        matches.truncate(100);
    }
    Ok(Results {
        entries: matches
            .into_iter()
            .map(|(_, _, path, label)| Entry {
                path: path.to_string_lossy().into_owned(),
                label,
            })
            .collect(),
        warnings,
    })
}

#[tauri::command]
pub async fn search_workspace_notes(
    app: tauri::AppHandle,
    workspace: PathBuf,
    query: String,
) -> Result<Results, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let documents = app.state::<Documents>();
        let root = documents
            .root()
            .ok_or("Open a folder to search its notes.")?;
        if root.link_base() != Path::new(&workspace) || !root.contains(root.link_base()) {
            return Err("The workspace changed. Reopen Quick Note Search.".into());
        }
        let result = search(&root, &query, 100_000)?;
        let current = documents.root().ok_or("The workspace closed.".to_owned())?;
        if current.link_base() != root.link_base()
            || current.watch_path() != root.watch_path()
            || !root.contains(root.link_base())
        {
            return Err("The workspace changed. Reopen Quick Note Search.".into());
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn filename_id_folder_and_unicode_matches_are_ranked_without_reading_contents() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("projects")).unwrap();
        for name in [
            "Alpha.md",
            "202611071530 Alpha.md",
            "projects/Alpha.md",
            "CAFÉ.markdown",
            "unrelated.txt",
        ] {
            fs::write(dir.path().join(name), [0xff]).unwrap();
        }
        let root = Root::new(dir.path()).unwrap();
        let result = search(&root, "ALPHA", 1000).unwrap();
        assert_eq!(result.entries.len(), 3);
        assert_eq!(result.entries[0].label, "Alpha.md");
        assert_eq!(
            search(&root, "202611071530", 1000).unwrap().entries.len(),
            1
        );
        assert_eq!(
            search(&root, "projects alpha", 1000).unwrap().entries[0].label,
            "projects/Alpha.md"
        );
        assert_eq!(search(&root, "café", 1000).unwrap().entries.len(), 1);
        assert!(search(&root, "absent", 1000).unwrap().entries.is_empty());
    }
    #[test]
    fn duplicate_ids_remain_distinct_and_partial_results_are_explicit() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "202611071530 A.md",
            "202611071530 B.md",
            ".hidden.md",
            "image.png",
        ] {
            fs::write(dir.path().join(name), "").unwrap();
        }
        let root = Root::new(dir.path()).unwrap();
        let result = search(&root, "202611071530", 1000).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(search(&root, "", 1000).unwrap().entries.len(), 2);
        assert!(!search(&root, "", 1).unwrap().warnings.is_empty());
        assert!(search(&root, &"a".repeat(257), 1000).is_err());
        for i in 0..101 {
            fs::write(dir.path().join(format!("note{i}.md")), "").unwrap();
        }
        let result = search(&root, "note", 1000).unwrap();
        assert_eq!(result.entries.len(), 100);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("100 matches"))
        );
    }
    #[cfg(unix)]
    #[test]
    fn aliases_are_deduplicated_and_external_files_and_linked_directories_excluded() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Note.md"), "").unwrap();
        fs::write(outside.path().join("Outside.md"), "").unwrap();
        symlink(
            dir.path().join("Note.md"),
            dir.path().join("202611071530 Alias.md"),
        )
        .unwrap();
        symlink(
            outside.path().join("Outside.md"),
            dir.path().join("Outside.md"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();
        let root = Root::new(dir.path()).unwrap();
        assert_eq!(search(&root, "", 1000).unwrap().entries.len(), 1);
        assert_eq!(
            search(&root, "202611071530", 1000).unwrap().entries[0].label,
            "Note.md"
        );
    }
    #[test]
    fn new_renamed_and_deleted_notes_reconcile_on_the_next_query() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::new(dir.path()).unwrap();
        assert!(search(&root, "", 1000).unwrap().entries.is_empty());
        let a = dir.path().join("A.md");
        let b = dir.path().join("B.md");
        fs::write(&a, "").unwrap();
        assert_eq!(search(&root, "a", 1000).unwrap().entries.len(), 1);
        fs::rename(a, &b).unwrap();
        assert!(search(&root, "a", 1000).unwrap().entries.is_empty());
        assert_eq!(search(&root, "b", 1000).unwrap().entries.len(), 1);
        fs::remove_file(b).unwrap();
        assert!(search(&root, "", 1000).unwrap().entries.is_empty());
    }
}
