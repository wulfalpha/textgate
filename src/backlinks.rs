//! A private, rebuildable workspace inventory. Disk scans run off the UI thread;
//! open editor snapshots override disk text without saving or granting paths.
use crate::{
    documents::{DocumentId, Documents},
    markdown, note_links, notes,
    workspace::EXTENSIONS,
};
use comrak::{Arena, nodes::NodeValue, parse_document};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;

const ENTRY_LIMIT: usize = 100_000;
const FILE_LIMIT: usize = 4 * 1024 * 1024;
const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
const RESULT_LIMIT: usize = 2000;
#[derive(Default)]
pub struct WorkspaceIndex(Mutex<Index>);
struct Index {
    entry_limit: usize,
    root: Option<(PathBuf, PathBuf)>,
    revision: u64,
    cache: HashMap<PathBuf, Arc<Parsed>>,
}
impl Default for Index {
    fn default() -> Self {
        Self {
            entry_limit: ENTRY_LIMIT,
            root: None,
            revision: 0,
            cache: HashMap::new(),
        }
    }
}
#[derive(Deserialize)]
pub struct OpenBuffer {
    document: DocumentId,
    contents: String,
}
#[derive(Clone)]
struct Link {
    path: String,
    wiki: bool,
    line: usize,
    column: usize,
    context: String,
}
struct Parsed {
    truncated: bool,
    text: String,
    links: Vec<Link>,
}
struct Note {
    source: PathBuf,
    document: Option<DocumentId>,
    parsed: Arc<Parsed>,
}
#[derive(Debug, Serialize)]
pub struct Entry {
    path: String,
    label: String,
    document: Option<DocumentId>,
    line: usize,
    column: usize,
    context: String,
}
#[derive(Debug, Serialize)]
pub struct Backlinks {
    entries: Vec<Entry>,
    warnings: Vec<String>,
    revision: u64,
    scanned: usize,
}

// Match splitNoteLink in the frontend: split fragments before URL decoding,
// refuse remote/absolute/query links, and never turn invalid escapes into paths.
pub(crate) fn link_path(url: &str) -> Option<String> {
    if url.starts_with(['/', '\\']) || url.contains('?') || url.split('#').next()?.contains(':') {
        return None;
    }
    let (path, fragment) = url.split_once('#').unwrap_or((url, ""));
    if path.is_empty() {
        return None;
    }
    decode_path(fragment)?;
    decode_path(path)
}
fn decode_path(path: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = path.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let digit = |b: u8| (b as char).to_digit(16).map(|n| n as u8);
            bytes.push(digit(input.next()?)? * 16 + digit(input.next()?)?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}
fn parse(text: String) -> Parsed {
    let arena = Arena::new();
    let root = parse_document(&arena, &text, &markdown::options());
    let lines: Vec<_> = text.lines().collect();
    let mut links = Vec::new();
    let mut truncated = false;
    for node in root.descendants() {
        let data = node.data.borrow();
        let (url, wiki) = match &data.value {
            NodeValue::Link(link) => (&link.url, false),
            NodeValue::WikiLink(link) if !link.embed => (&link.url, true),
            _ => continue,
        };
        let Some(path) = link_path(url) else { continue };
        let position = data.sourcepos.start;
        let source_line = lines
            .get(position.line.saturating_sub(1))
            .copied()
            .unwrap_or("");
        let column = source_line
            .get(..position.column.saturating_sub(1))
            .map_or(0, |s| s.encode_utf16().count())
            + 1;
        if links.len() >= 5000 {
            truncated = true;
            break;
        }
        links.push(Link {
            path,
            wiki,
            line: position.line,
            column,
            context: source_line.chars().take(240).collect(),
        });
    }
    Parsed {
        text,
        links,
        truncated,
    }
}
fn normalized(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}
fn warn(warnings: &mut Vec<String>, message: String) {
    if warnings.len() < 100 {
        warnings.push(message);
    }
}
fn canonical(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}
fn note_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.split(' ').next()?;
    ((12..=14).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_owned())
}

pub(crate) struct Inventory {
    pub paths: BTreeSet<PathBuf>,
    pub ids: BTreeMap<String, BTreeSet<PathBuf>>,
    pub warnings: Vec<String>,
    pub complete: bool,
}
pub(crate) fn inventory(root: &crate::workspace::Root, entry_limit: usize) -> Inventory {
    let mut warnings = Vec::new();
    let mut inventory = BTreeSet::new();
    let mut ids: BTreeMap<String, BTreeSet<PathBuf>> = BTreeMap::new();
    let mut folders = vec![root.watch_path().to_path_buf()];
    let mut seen = 0;
    let mut inventory_complete = true;
    'scan: while let Some(folder) = folders.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                inventory_complete = false;
                warn(&mut warnings, format!("{}: {error}", folder.display()));
                continue;
            }
        };
        for entry in entries {
            seen += 1;
            if seen > entry_limit {
                inventory_complete = false;
                warn(
                    &mut warnings,
                    format!(
                        "Workspace scan stopped after {} entries; results are incomplete.",
                        entry_limit
                    ),
                );
                break 'scan;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    inventory_complete = false;
                    warn(&mut warnings, error.to_string());
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                inventory_complete = false;
                warn(&mut warnings, "A non-Unicode filename was skipped.".into());
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) => {
                    inventory_complete = false;
                    warn(&mut warnings, format!("{}: {error}", path.display()));
                    continue;
                }
            };
            if kind.is_dir() {
                if root.contains(&path) {
                    folders.push(path);
                }
                continue;
            }
            if !path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| EXTENSIONS.iter().any(|e| s.eq_ignore_ascii_case(e)))
            {
                continue;
            }
            // Never follow directory symlinks or grant paths outside the root.
            if !root.contains(&path) || !path.is_file() {
                continue;
            }
            let Some(real) = canonical(&path) else {
                warn(
                    &mut warnings,
                    format!("{} could not be resolved.", path.display()),
                );
                continue;
            };
            if let Some(id) = note_id(&path) {
                ids.entry(id).or_default().insert(real.clone());
            }
            inventory.insert(real);
        }
    }
    Inventory {
        paths: inventory,
        ids,
        warnings,
        complete: inventory_complete,
    }
}

pub(crate) fn outgoing(source: &str) -> Result<Vec<(String, bool)>, String> {
    let parsed = parse(normalized(source));
    if parsed.truncated {
        return Err("More than 5,000 links in a note; a complete rename scan is required.".into());
    }
    Ok(parsed
        .links
        .into_iter()
        .map(|link| (link.path, link.wiki))
        .collect())
}

impl Index {
    fn parsed(&mut self, path: &Path, text: String) -> Arc<Parsed> {
        if let Some(old) = self.cache.get(path)
            && old.text == text
        {
            return old.clone();
        }
        let parsed = Arc::new(parse(text));
        self.cache.insert(path.to_path_buf(), parsed.clone());
        parsed
    }
    fn query(
        &mut self,
        documents: &Documents,
        target: DocumentId,
        buffers: Vec<OpenBuffer>,
    ) -> Result<Backlinks, String> {
        let root = documents.root().ok_or("Open a folder to see backlinks.")?;
        if !root.contains(root.link_base()) {
            return Err("The workspace moved. Choose Open Folder again.".into());
        }
        let target = documents
            .document_path(target)
            .map_err(|_| "The current tab is no longer open.")?
            .ok_or("Save this note inside the open folder to see backlinks.")?;
        if !root.contains(&target) {
            return Err(
                "This note is outside the open folder. Open its folder to see backlinks.".into(),
            );
        }
        let target = canonical(&target)
            .ok_or("This note is missing on disk. Backlinks will resume when it is restored.")?;
        let signature = (
            root.link_base().to_path_buf(),
            root.watch_path().to_path_buf(),
        );
        if self.root.as_ref() != Some(&signature) {
            self.cache.clear();
            self.root = Some(signature.clone());
        }
        self.revision += 1;
        let mut warnings = Vec::new();
        let mut overlays = HashMap::new();
        let mut used = 0;
        for buffer in buffers {
            let path = documents
                .document_path(buffer.document)
                .map_err(|_| "An editor tab changed during indexing. Refresh backlinks.")?;
            let Some(path) = path else { continue };
            if !root.contains(&path) {
                continue;
            }
            used += buffer.contents.len();
            if buffer.contents.len() > FILE_LIMIT || used > TOTAL_LIMIT {
                return Err(
                    "Open notes exceed the backlink indexing limit (4 MiB per note, 64 MiB total)."
                        .into(),
                );
            }
            // Deleted open sources keep their outgoing links; navigation uses the
            // native document handle rather than trying to reopen a missing file.
            let real = canonical(&path).or_else(|| {
                canonical(path.parent()?).map(|p| p.join(path.file_name().unwrap_or_default()))
            });
            if let Some(real) = real {
                overlays.insert(real, (path, buffer.document, buffer.contents));
            }
        }
        let scanned = inventory(&root, self.entry_limit);
        let inventory = scanned.paths;
        let ids = scanned.ids;
        let inventory_complete = scanned.complete;
        for warning in scanned.warnings {
            warn(&mut warnings, warning);
        }
        let mut records = BTreeMap::new();
        let open_paths: BTreeSet<_> = overlays.keys().cloned().collect();
        let mut link_count = 0;
        for (real, (source, document, contents)) in overlays {
            if link_count >= 100_000 {
                warn(
                    &mut warnings,
                    "Link indexing limit reached; results are incomplete.".into(),
                );
                break;
            }
            let parsed = self.parsed(&real, normalized(&contents));
            link_count += parsed.links.len();
            records.insert(
                real.clone(),
                Note {
                    source,
                    document: Some(document),
                    parsed,
                },
            );
        }
        for path in &inventory {
            if open_paths.contains(path) {
                continue;
            }
            if link_count >= 100_000 {
                warn(
                    &mut warnings,
                    "Link indexing limit reached; results are incomplete.".into(),
                );
                break;
            }
            let contents = (|| -> Result<String, String> {
                let file = fs::File::open(path).map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                file.take((FILE_LIMIT + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                used += bytes.len();
                if bytes.len() > FILE_LIMIT || used > TOTAL_LIMIT {
                    return Err(
                        "Backlink indexing size limit reached; results are incomplete.".into(),
                    );
                }
                String::from_utf8(bytes)
                    .map_err(|_| "Not valid UTF-8; skipped without modifying the file.".into())
            })();
            match contents {
                Ok(text) => {
                    let parsed = self.parsed(path, normalized(&text));
                    link_count += parsed.links.len();
                    records.insert(
                        path.clone(),
                        Note {
                            source: path.clone(),
                            document: None,
                            parsed,
                        },
                    );
                }
                Err(error) => {
                    warn(&mut warnings, format!("{}: {error}", path.display()));
                }
            }
            if used > TOTAL_LIMIT {
                break;
            }
        }
        self.cache.retain(|path, _| records.contains_key(path));
        if !inventory_complete {
            warn(
                &mut warnings,
                "ID links were omitted because the workspace inventory is incomplete.".into(),
            );
        }
        let mut entries = Vec::new();
        let mut parsed_links = 0;
        let mut ambiguous = false;
        'notes: for (source, note) in &records {
            if note.parsed.truncated {
                warn(
                    &mut warnings,
                    format!(
                        "{}: only the first 5,000 links were indexed.",
                        note.source.display()
                    ),
                );
            }
            parsed_links += note.parsed.links.len();
            if parsed_links > 100_000 {
                warn(
                    &mut warnings,
                    "Link limit reached; backlink results are incomplete.".into(),
                );
                break;
            }
            if source == &target {
                continue;
            }
            for link in &note.parsed.links {
                let resolved = if link.wiki
                    && let Some(id) = notes::link_id(&link.path)
                {
                    match ids.get(id).filter(|_| inventory_complete) {
                        Some(paths) if paths.len() == 1 => paths.first().cloned(),
                        Some(_) => {
                            ambiguous = true;
                            None
                        }
                        None => None,
                    }
                } else {
                    note_links::candidates(
                        Some(&root),
                        Some(&note.source),
                        &link.path,
                        link.wiki,
                        &EXTENSIONS,
                    )
                    .ok()
                    .and_then(|paths| {
                        paths.into_iter().filter_map(|p| canonical(&p)).find(|p| {
                            p.is_file()
                                && (root.contains(p)
                                    || documents.chosen(p)
                                    || documents.granted_path_for(p).is_some())
                        })
                    })
                };
                if resolved.as_ref() != Some(&target) {
                    continue;
                }
                entries.push(Entry {
                    path: note.source.to_string_lossy().into_owned(),
                    label: crate::workspace::relative_label(&root, &note.source),
                    document: note.document,
                    line: link.line,
                    column: link.column,
                    context: link.context.clone(),
                });
                if entries.len() >= RESULT_LIMIT {
                    warn(
                        &mut warnings,
                        "Showing the first 2,000 backlinks; results are incomplete.".into(),
                    );
                    break 'notes;
                }
            }
        }
        if ambiguous {
            warn(&mut warnings, "Ambiguous note-ID links were omitted; duplicate IDs must be resolved before these backlinks can be shown.".into());
        }
        let current = documents.root();
        if !current.is_some_and(|r| {
            r.link_base() == signature.0
                && r.watch_path() == signature.1
                && r.contains(r.link_base())
        }) {
            self.cache.clear();
            self.root = None;
            return Err("The workspace changed during indexing. Refresh backlinks.".into());
        }
        Ok(Backlinks {
            entries,
            warnings,
            revision: self.revision,
            scanned: records.len(),
        })
    }
}

#[tauri::command]
pub async fn workspace_backlinks(
    app: tauri::AppHandle,
    document: DocumentId,
    buffers: Vec<OpenBuffer>,
) -> Result<Backlinks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<WorkspaceIndex>().0.lock().unwrap().query(
            &app.state::<Documents>(),
            document,
            buffers,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Root;
    fn setup(root: &Path, target: &str) -> (Documents, DocumentId) {
        let docs = Documents::default();
        docs.set_root(Some(Root::new(root).unwrap()));
        let id = docs
            .restore_recovery(Some((root.join(target), None)), "", false)
            .unwrap()
            .0;
        (docs, id)
    }
    #[test]
    fn backlink_destinations_decode_paths_but_reject_invalid_fragments_and_remote_links() {
        assert_eq!(
            link_path("Next%20note.md#caf%C3%A9"),
            Some("Next note.md".into())
        );
        for url in [
            "https://example.com/a.md",
            "//host/a.md",
            "#heading",
            "note.md?query",
            "note.md#%ZZ",
            "note.md#%FF",
        ] {
            assert_eq!(link_path(url), None, "{url}");
        }
    }
    #[test]
    fn parsed_backlinks_share_navigation_rules_and_skip_code_images_and_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("202611071530 Target.md"), "# Target").unwrap();
        fs::write(dir.path().join("source.md"), "---\nx: '[[202611071530]]'\n---\n\n[ref][next]\n\n[next]: <202611071530 Target.md>\n\n[[202611071530 Old title|Alias]]\n\n`[[202611071530]]`\n\n![image](202611071530%20Target.md)\n\n```\n[[202611071530]]\n```\n").unwrap();
        let (docs, target) = setup(dir.path(), "202611071530 Target.md");
        let result = Index::default().query(&docs, target, vec![]).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.entries[0].line, 5);
        assert_eq!(result.entries[1].line, 9);
    }
    #[test]
    fn open_buffers_override_disk_and_closing_restores_disk_results() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("target.md"), "").unwrap();
        fs::write(dir.path().join("source.md"), "[[target]]").unwrap();
        let (docs, target) = setup(dir.path(), "target.md");
        let source = docs
            .restore_recovery(Some((dir.path().join("source.md"), None)), "", false)
            .unwrap()
            .0;
        let mut index = Index::default();
        assert_eq!(index.query(&docs, target, vec![]).unwrap().entries.len(), 1);
        assert!(
            index
                .query(
                    &docs,
                    target,
                    vec![OpenBuffer {
                        document: source,
                        contents: "unsaved removal".into()
                    }]
                )
                .unwrap()
                .entries
                .is_empty()
        );
        assert_eq!(index.query(&docs, target, vec![]).unwrap().entries.len(), 1);
        fs::write(dir.path().join("source.md"), "external removal").unwrap();
        assert!(
            index
                .query(&docs, target, vec![])
                .unwrap()
                .entries
                .is_empty()
        );
        fs::write(dir.path().join("source.md"), "[[target]]").unwrap();
        fs::rename(dir.path().join("source.md"), dir.path().join("renamed.md")).unwrap();
        assert!(
            index.query(&docs, target, vec![]).unwrap().entries[0]
                .path
                .ends_with("renamed.md")
        );
        fs::remove_file(dir.path().join("renamed.md")).unwrap();
        assert!(
            index
                .query(&docs, target, vec![])
                .unwrap()
                .entries
                .is_empty()
        );
    }
    #[test]
    fn incomplete_inventory_does_not_guess_id_uniqueness_and_deleted_open_sources_keep_their_links()
    {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("202611071530 Target.md"), "").unwrap();
        fs::write(dir.path().join("source.md"), "[[202611071530]]").unwrap();
        let (docs, target) = setup(dir.path(), "202611071530 Target.md");
        let source = docs
            .restore_recovery(Some((dir.path().join("source.md"), None)), "", false)
            .unwrap()
            .0;
        let mut limited = Index {
            entry_limit: 1,
            ..Index::default()
        };
        let result = limited
            .query(
                &docs,
                target,
                vec![OpenBuffer {
                    document: source,
                    contents: "[[202611071530]]".into(),
                }],
            )
            .unwrap();
        assert!(result.entries.is_empty());
        assert!(
            result
                .warnings
                .iter()
                .any(|s| s.contains("inventory is incomplete"))
        );
        fs::remove_file(dir.path().join("source.md")).unwrap();
        let result = Index::default()
            .query(
                &docs,
                target,
                vec![OpenBuffer {
                    document: source,
                    contents: "[[202611071530]]".into(),
                }],
            )
            .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].document, Some(source));
    }
    #[test]
    fn duplicate_ids_are_ambiguous_but_explicit_paths_work_and_invalid_utf8_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("202611071530 A.md"), "").unwrap();
        fs::write(dir.path().join("202611071530 B.md"), "").unwrap();
        fs::write(
            dir.path().join("source.md"),
            "[[202611071530]]\n\n[exact](202611071530%20A.md)",
        )
        .unwrap();
        fs::write(dir.path().join("bad.md"), [0xff]).unwrap();
        let (docs, target) = setup(dir.path(), "202611071530 A.md");
        let result = Index::default().query(&docs, target, vec![]).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(result.warnings.iter().any(|s| s.contains("UTF-8")));
        assert!(result.warnings.iter().any(|s| s.contains("Ambiguous")));
    }
    #[test]
    fn workspace_changes_discard_old_inventory_and_unicode_columns_are_utf16() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        fs::write(first.path().join("target.md"), "").unwrap();
        fs::write(first.path().join("source.md"), "🦋 [[target]]").unwrap();
        let (docs, target) = setup(first.path(), "target.md");
        let mut index = Index::default();
        assert_eq!(
            index.query(&docs, target, vec![]).unwrap().entries[0].column,
            4
        );
        docs.set_root(Some(Root::new(second.path()).unwrap()));
        assert!(index.query(&docs, target, vec![]).is_err());
        fs::write(second.path().join("target.md"), "").unwrap();
        let new_target = docs
            .restore_recovery(Some((second.path().join("target.md"), None)), "", false)
            .unwrap()
            .0;
        assert!(
            index
                .query(&docs, new_target, vec![])
                .unwrap()
                .entries
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlink_aliases_count_once_and_outside_or_linked_folders_are_not_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("202611071530 A.md"), "").unwrap();
        fs::write(dir.path().join("source.md"), "[[202611071530]]").unwrap();
        fs::write(outside.path().join("untrusted.md"), "[[202611071530]]").unwrap();
        std::os::unix::fs::symlink(dir.path().join("source.md"), dir.path().join("alias.md"))
            .unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("202611071530 A.md"),
            dir.path().join("202611071530 Alias.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        let (docs, target) = setup(dir.path(), "202611071530 A.md");
        assert_eq!(
            Index::default()
                .query(&docs, target, vec![])
                .unwrap()
                .entries
                .len(),
            1
        );
    }
}
