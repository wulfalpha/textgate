//! Zettelkasten notes: new notes named with a timestamp ID (`202611071530
//! Title.md`), and finding a note anywhere in the workspace by that ID.
use crate::documents::Documents;
use crate::workspace::{EXTENSIONS, Root, checked_name, file_name};
use std::{fs, io, io::Write, path::PathBuf};
use tauri::Manager;

/// New note IDs: `YYYYMMDDHHMM` in local time.
const ID_LENGTH: usize = 12;
/// Links may also name IDs from other tools that add seconds.
const LINK_ID_LENGTHS: std::ops::RangeInclusive<usize> = 12..=14;
/// Stops a search through a very large folder from hanging the app.
const SEARCH_LIMIT: usize = 100_000;

fn is_id(text: &str, lengths: &std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// The ID a wiki link names, as `[[202611071530]]` or `[[202611071530 Any title]]`.
pub(crate) fn link_id(link: &str) -> Option<&str> {
    let link = link.trim();
    let id = link.split_once(' ').map_or(link, |(id, _)| id);
    is_id(id, &LINK_ID_LENGTHS).then_some(id)
}

// A note's ID: its name without a Markdown or text extension, either the ID
// alone or the ID followed by a space and a title.
fn names_id(file: &str, id: &str) -> bool {
    let stem = match file.rsplit_once('.') {
        Some((stem, extension))
            if EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()) =>
        {
            stem
        }
        _ => return false,
    };
    stem.strip_prefix(id)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
}

/// Notes in the workspace carrying `id`, as real paths. Hidden entries are
/// skipped and linked folders are not followed, so the search stays inside.
pub(crate) fn find_id(root: &Root, id: &str) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut folders = vec![root.watch_path().to_path_buf()];
    let mut seen = 0;
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder)? {
            seen += 1;
            if seen > SEARCH_LIMIT {
                return Err(io::Error::other(
                    "The open folder is too large to search for note IDs.",
                ));
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.push(entry.path());
            } else if names_id(name, id) {
                let path = entry.path();
                // A linked file counts only when it resolves inside the workspace.
                if kind.is_file() || (root.contains(&path) && path.is_file()) {
                    found.push(fs::canonicalize(&path)?);
                }
            }
        }
    }
    found.sort();
    Ok(found)
}

/// The one note carrying `id`, or a message saying why there is not exactly one.
pub(crate) fn resolve_id(root: &Root, id: &str) -> Result<PathBuf, String> {
    let mut found = find_id(root, id).map_err(|error| error.to_string())?;
    match found.len() {
        0 => Err(format!(
            "No note with ID {id} was found. No file was created."
        )),
        1 => Ok(found.remove(0)),
        _ => {
            let names: Vec<_> = found
                .iter()
                .filter_map(|path| path.strip_prefix(root.watch_path()).ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            Err(format!(
                "{} notes share the ID {id}: {}. Rename one so each ID is unique.",
                found.len(),
                names.join(", ")
            ))
        }
    }
}

// Creates `ID Title.md` (or `ID.md`) in the workspace folder, using the first
// candidate ID no note already carries. Never replaces a file.
fn create(root: &Root, title: &str, ids: &[String]) -> Result<PathBuf, String> {
    let title = title.trim();
    if !title.is_empty() {
        checked_name(title)?;
    }
    if ids.is_empty() || ids.iter().any(|id| !is_id(id, &(ID_LENGTH..=ID_LENGTH))) {
        return Err("Note IDs must be 12 digits.".into());
    }
    for id in ids {
        if !find_id(root, id)
            .map_err(|error| error.to_string())?
            .is_empty()
        {
            continue;
        }
        let name = if title.is_empty() {
            format!("{id}.md")
        } else {
            file_name(&format!("{id} {title}"))
        };
        let path = root.link_base().join(name);
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        if !title.is_empty() {
            file.write_all(format!("# {title}\n\n").as_bytes())
                .map_err(|error| error.to_string())?;
        }
        return Ok(path);
    }
    Err("Every note ID for the next hour is taken. Try again later.".into())
}

#[tauri::command]
pub async fn create_note(
    app: tauri::AppHandle,
    title: String,
    ids: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app
            .state::<Documents>()
            .root()
            .ok_or("Open a folder first. New notes are created in the open folder.")?;
        let path = create(&root, &title, &ids)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "The name is not valid Unicode.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn root_for(path: &Path) -> Root {
        Root::new(path).unwrap()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn link_ids_are_12_to_14_digits_optionally_followed_by_a_title() {
        assert_eq!(link_id("202611071530"), Some("202611071530"));
        assert_eq!(link_id("202611071530 Some title"), Some("202611071530"));
        assert_eq!(link_id("20261107153045"), Some("20261107153045"));
        for link in [
            "2026110715",
            "202611071530x",
            "Title 202611071530",
            "202611071530123",
            "",
        ] {
            assert_eq!(link_id(link), None, "{link}");
        }
    }

    #[test]
    fn note_names_carry_an_id_alone_or_before_a_title() {
        assert!(names_id("202611071530.md", "202611071530"));
        assert!(names_id("202611071530 Luhmann.MD", "202611071530"));
        assert!(names_id("202611071530 notes.txt", "202611071530"));
        assert!(!names_id("2026110715301.md", "202611071530"));
        assert!(!names_id("202611071530-x.md", "202611071530"));
        assert!(!names_id("202611071530.png", "202611071530"));
        assert!(!names_id("202611071530", "202611071530"));
    }

    #[test]
    fn new_notes_get_an_id_name_a_heading_and_the_next_free_minute() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_for(dir.path());
        let first = create(
            &root,
            " Reading notes ",
            &ids(&["202611071530", "202611071531"]),
        )
        .unwrap();
        assert_eq!(first, dir.path().join("202611071530 Reading notes.md"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "# Reading notes\n\n");

        // The minute is taken by a note in a subfolder too.
        fs::create_dir(dir.path().join("archive")).unwrap();
        fs::write(dir.path().join("archive/202611071531 Old.md"), "old").unwrap();
        let second = create(
            &root,
            "",
            &ids(&["202611071530", "202611071531", "202611071532"]),
        )
        .unwrap();
        assert_eq!(second, dir.path().join("202611071532.md"));
        assert_eq!(fs::read_to_string(&second).unwrap(), "");

        assert!(
            create(&root, "x", &ids(&["202611071530"]))
                .unwrap_err()
                .contains("taken")
        );
        assert!(create(&root, "a/b", &ids(&["202611071533"])).is_err());
        assert!(create(&root, "x", &ids(&["2026"])).is_err());
        assert!(create(&root, "x", &[]).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn ids_resolve_anywhere_in_the_workspace_and_duplicates_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        fs::write(dir.path().join("a/b/202611071530 Deep note.md"), "").unwrap();
        fs::write(dir.path().join(".hidden/202611071531.md"), "").unwrap();
        let root = root_for(dir.path());
        assert_eq!(
            resolve_id(&root, "202611071530").unwrap(),
            fs::canonicalize(dir.path().join("a/b/202611071530 Deep note.md")).unwrap()
        );
        assert!(
            resolve_id(&root, "202611071531")
                .unwrap_err()
                .contains("No note")
        );
        fs::write(dir.path().join("202611071530.md"), "").unwrap();
        let error = resolve_id(&root, "202611071530").unwrap_err();
        assert!(error.contains("2 notes share"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn id_search_does_not_follow_links_out_of_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root_dir = dir.path().join("notes");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("202611071530.md"), "").unwrap();
        std::os::unix::fs::symlink(&outside, root_dir.join("linked")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("202611071530.md"),
            root_dir.join("202611071530 Link.md"),
        )
        .unwrap();
        assert!(
            find_id(&root_for(&root_dir), "202611071530")
                .unwrap()
                .is_empty()
        );
    }
}
