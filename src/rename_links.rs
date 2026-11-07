//! Reviewed multi-file rename operations. The native side owns snapshots,
//! permissions, destination resolution, preflight checks and durable progress.
use crate::{
    backlinks,
    documents::{self, DocumentId, Documents, SaveError},
    notes,
    recovery::{self, Checkpoint, Session},
    workspace::{self, EXTENSIONS, Root},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::Manager;
const FILE_LIMIT: usize = 4 * 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Default)]
pub struct Renames(Mutex<Option<Plan>>);
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub before: String,
    pub insert: String,
    pub line: usize,
    pub context: String,
    pub after_context: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct RawEdit {
    from: usize,
    to: usize,
    before: String,
    insert: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Source {
    key: usize,
    path: PathBuf,
    identity: Option<String>,
    disk: Option<String>,
    text: String,
    document: Option<DocumentId>,
    edits: Vec<RawEdit>,
    after: String,
}
#[derive(Clone)]
struct Plan {
    token: String,
    root: Root,
    from: PathBuf,
    target: PathBuf,
    to: PathBuf,
    old_real: PathBuf,
    target_identity: String,
    sources: Vec<Source>,
    paths: BTreeSet<PathBuf>,
    named: Vec<(DocumentId, PathBuf)>,
    checkpoint: Checkpoint,
    issues: Vec<String>,
    finalized: bool,
    retry: bool,
    prior_links: BTreeMap<PathBuf, Vec<(String, bool)>>,
}
#[derive(Serialize)]
pub struct ParseSource {
    key: usize,
    text: String,
}
#[derive(Serialize)]
pub struct Scan {
    token: String,
    sources: Vec<ParseSource>,
}
#[derive(Deserialize)]
pub struct Span {
    from: usize,
    to: usize,
    wiki: bool,
    reference: bool,
}
#[derive(Deserialize)]
pub struct Candidates {
    key: usize,
    spans: Vec<Span>,
}
#[derive(Serialize)]
pub struct PreviewFile {
    path: String,
    label: String,
    editor: bool,
    edits: Vec<Edit>,
}
#[derive(Serialize)]
pub struct Preview {
    token: String,
    from: String,
    to: String,
    files: Vec<PreviewFile>,
    issues: Vec<String>,
    retry: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Step {
    path: PathBuf,
    before: String,
    after: String,
    identity: String,
    replacement: Option<String>,
    done: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    version: u32,
    token: String,
    root_given: PathBuf,
    root_real: PathBuf,
    from: PathBuf,
    to: PathBuf,
    target_identity: String,
    before: Session,
    after: Session,
    steps: Vec<Step>,
    renamed: bool,
    error: Option<String>,
    #[serde(default)]
    named: Vec<(DocumentId, PathBuf)>,
}
#[derive(Serialize)]
pub struct OpenPatch {
    pub document: DocumentId,
    pub edits: Vec<Edit>,
}
#[derive(Serialize)]
pub struct Outcome {
    pub token: String,
    pub renamed: Option<workspace::Renamed>,
    pub patches: Vec<OpenPatch>,
    pub written: usize,
    pub pending: usize,
    pub error: Option<String>,
    pub rename_done: bool,
    pub written_files: Vec<String>,
    pub pending_files: Vec<String>,
    pub editor_files: Vec<String>,
}
#[derive(Serialize)]
pub struct Pending {
    token: String,
    from: String,
    to: String,
    written: usize,
    pending: usize,
    error: Option<String>,
    rename_done: bool,
    documents: Vec<(DocumentId, String)>,
}
fn failure(error: SaveError) -> String {
    match error {
        SaveError::Io { message } | SaveError::AlreadyOpen { message, .. } => message,
        SaveError::Conflict { .. } => {
            "A file changed outside Textgate. No unseen version was overwritten.".into()
        }
    }
}
fn io_failure(message: String) -> SaveError {
    SaveError::Io { message }
}
fn token() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn projected(path: &Path) -> Result<PathBuf, String> {
    Ok(fs::canonicalize(path.parent().ok_or("No parent folder.")?)
        .map_err(|e| e.to_string())?
        .join(path.file_name().ok_or("No filename.")?))
}
fn read(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("A source is no longer a regular file.".into());
    }
    let mut bytes = Vec::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("A source is no longer a regular file.".into());
    }
    file.take((FILE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > FILE_LIMIT {
        return Err("A note exceeds the 4 MiB rename scan limit.".into());
    }
    String::from_utf8(bytes)
        .map_err(|_| "A note is not valid UTF-8. It was not converted or changed.".into())
}
fn identity(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(path).map_err(|e| e.to_string())?;
        Ok(format!("{}:{}", m.dev(), m.ino()))
    }
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
        };
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: a live handle and correctly sized writable FILE_ID_INFO.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileIdInfo,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(format!(
            "{}:{}",
            info.VolumeSerialNumber,
            info.FileId
                .Identifier
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ))
    }
}
fn hard_linked(path: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(fs::metadata(path).map_err(|e| e.to_string())?.nlink() > 1)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_STANDARD_INFO, FileStandardInfo, GetFileInformationByHandleEx,
        };
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: a live handle and a correctly sized FILE_STANDARD_INFO buffer.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStandardInfo,
                (&mut info as *mut FILE_STANDARD_INFO).cast(),
                std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(info.NumberOfLinks > 1)
    }
}
fn label(root: &Root, path: &Path) -> String {
    workspace::relative_label(root, path)
}
fn same_checkpoint(a: &Checkpoint, b: &Checkpoint) -> bool {
    !a.closed
        && !b.closed
        && a.tabs.len() == b.tabs.len()
        && a.tabs.iter().zip(&b.tabs).all(|(a, b)| {
            a.document == b.document && a.contents == b.contents && a.dirty == b.dirty
        })
}
fn byte_at(text: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += character.len_utf16();
        if units > offset {
            return Err("A link offset splits a Unicode character.".into());
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err("A link offset is outside its source snapshot.".into())
    }
}
fn editor_offset(text: &str, byte: usize) -> usize {
    text[..byte]
        .strip_prefix('\u{feff}')
        .unwrap_or(&text[..byte])
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .encode_utf16()
        .count()
}
fn editor_edits(source: &Source) -> Vec<Edit> {
    source
        .edits
        .iter()
        .map(|edit| {
            let prefix = source.text[..edit.from]
                .rsplit(['\r', '\n'])
                .next()
                .unwrap_or("");
            let suffix = source.text[edit.to..]
                .split(['\r', '\n'])
                .next()
                .unwrap_or("");
            let prefix: String = prefix
                .chars()
                .rev()
                .take(80)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let suffix: String = suffix.chars().take(80).collect();
            Edit {
                from: editor_offset(&source.text, edit.from),
                to: editor_offset(&source.text, edit.to),
                before: edit.before.clone(),
                insert: edit.insert.clone(),
                line: source.text[..edit.from]
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .matches('\n')
                    .count()
                    + 1,
                context: format!("{prefix}{}{suffix}", edit.before),
                after_context: format!("{prefix}{}{suffix}", edit.insert),
            }
        })
        .collect()
}
fn unescape(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|c| c.is_ascii_punctuation()) {
            out.push(chars.next().unwrap());
        } else {
            out.push(c);
        }
    }
    out
}

// Independently verify worker spans against the native Markdown tree. Link
// ranges are inclusive in comrak and use UTF-8 columns; worker offsets use
// UTF-16. Reference destinations live in definitions, not link usage nodes.
type LinkRange = (usize, usize, String, bool);
type ByteRange = (usize, usize);
type DestinationGuards = (Vec<LinkRange>, Vec<ByteRange>);
fn guards(text: &str) -> DestinationGuards {
    let bom = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let raw = &text[bom..];
    let mut starts = vec![bom];
    let bytes = raw.as_bytes();
    for (i, &byte) in bytes.iter().enumerate() {
        if byte == b'\n' || (byte == b'\r' && bytes.get(i + 1) != Some(&b'\n')) {
            starts.push(bom + i + 1);
        }
    }
    let offset = |position: comrak::nodes::LineColumn| {
        starts
            .get(position.line.saturating_sub(1))
            .copied()
            .unwrap_or(text.len())
            .saturating_add(position.column.saturating_sub(1))
            .min(text.len())
    };
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, raw, &crate::markdown::options());
    let mut allowed = Vec::new();
    let mut excluded = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        let range = (
            offset(data.sourcepos.start),
            (offset(data.sourcepos.end) + 1).min(text.len()),
        );
        match &data.value {
            comrak::nodes::NodeValue::Link(link) => {
                if let Some(path) = backlinks::link_path(&link.url) {
                    allowed.push((range.0, range.1, path, false));
                }
            }
            comrak::nodes::NodeValue::WikiLink(link) if !link.embed => {
                if let Some(path) = backlinks::link_path(&link.url) {
                    allowed.push((range.0, range.1, path, true));
                }
            }
            comrak::nodes::NodeValue::Code(_)
            | comrak::nodes::NodeValue::CodeBlock(_)
            | comrak::nodes::NodeValue::FrontMatter(_)
            | comrak::nodes::NodeValue::HtmlBlock(_)
            | comrak::nodes::NodeValue::HtmlInline(_) => excluded.push(range),
            _ => {}
        }
    }
    (allowed, excluded)
}

fn allowed_span(
    text: &str,
    span: &Span,
    from: usize,
    to: usize,
    path: &str,
    allowed: &[LinkRange],
    excluded: &[ByteRange],
) -> bool {
    if excluded
        .iter()
        .any(|&(start, end)| from < end && to > start)
    {
        return false;
    }
    if span.reference {
        if !allowed.iter().any(|(_, _, p, w)| !w && p == path) {
            return false;
        }
        let prefix = text[..from]
            .rsplit(['\n', '\r'])
            .next()
            .unwrap_or("")
            .trim_end()
            .trim_end_matches('<')
            .trim_end();
        return prefix
            .rfind("]:")
            .is_some_and(|i| prefix[i + 2..].trim().is_empty())
            || (prefix.is_empty()
                && text[..from]
                    .trim_end()
                    .trim_end_matches('<')
                    .trim_end()
                    .ends_with(":"));
    }
    if !allowed
        .iter()
        .any(|(start, end, p, w)| from >= *start && to <= *end && p == path && *w == span.wiki)
    {
        return false;
    }
    let prefix = text[..from].trim_end();
    if span.wiki {
        prefix.ends_with("[[")
    } else {
        prefix.ends_with('(') || prefix.ends_with('<')
    }
}
fn encode(path: &str) -> String {
    let mut out = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
fn relative(from: &Path, to: &Path) -> Result<String, String> {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    if shared == 0 {
        return Err("The renamed note is on a different volume.".into());
    }
    let mut parts = vec!["..".to_owned(); from.len() - shared];
    parts.extend(
        to[shared..]
            .iter()
            .map(|p| p.as_os_str().to_string_lossy().into_owned()),
    );
    Ok(parts.join("/"))
}
fn file_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.split(' ').next()?;
    ((12..=14).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.into())
}
fn destination(path: &Path, name: &str) -> Result<PathBuf, String> {
    let name = workspace::checked_name(name)?;
    let supported = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| EXTENSIONS.iter().any(|e| s.eq_ignore_ascii_case(e)));
    Ok(path.with_file_name(if supported {
        name.to_owned()
    } else {
        format!(
            "{name}.{}",
            path.extension().and_then(|s| s.to_str()).unwrap_or("md")
        )
    }))
}

fn removed_links(before: &str, after: &str) -> Vec<(String, bool)> {
    let before = backlinks::outgoing(before).unwrap_or_default();
    let after = backlinks::outgoing(after).unwrap_or_default();
    before
        .into_iter()
        .filter(|link| !after.contains(link))
        .collect()
}
fn prepare(
    documents: &Documents,
    path: &Path,
    name: &str,
    checkpoint: Checkpoint,
    old: Option<&Journal>,
) -> Result<Plan, String> {
    if checkpoint.closed {
        return Err("A live editor snapshot is required.".into());
    }
    let root = documents
        .root()
        .ok_or("Open a folder before renaming notes.")?;
    if !root.contains(root.link_base()) || !root.contains(path) {
        return Err("The note is no longer inside the chosen workspace.".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("Link updates require a regular note file; linked files can be renamed separately in the file manager.".into());
    }
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| EXTENSIONS.iter().any(|e| s.eq_ignore_ascii_case(e)))
    {
        return Err("Choose a Markdown or text note for link-aware rename.".into());
    }
    let to = destination(path, name)?;
    if file_id(path).is_some() && file_id(path) != file_id(&to) {
        return Err("Keep the note's ID prefix when changing its title.".into());
    }
    let target_identity = identity(path)?;
    if to != path && fs::symlink_metadata(&to).is_ok() && identity(&to)? != target_identity {
        return Err("The destination already exists.".into());
    }
    let scan = backlinks::inventory(&root, 100_000);
    let paths = scan.paths;
    let mut issues = scan.warnings;
    if !scan.complete {
        issues.push("The workspace inventory is incomplete; link updates are disabled.".into());
    }
    let mut sources = BTreeMap::new();
    let mut used = 0;
    for source in &paths {
        match read(source) {
            Ok(text) => {
                used += text.len();
                if used > TOTAL_LIMIT {
                    issues.push(
                        "The complete rename scan exceeds 16 MiB; link updates are disabled."
                            .into(),
                    );
                    break;
                }
                sources.insert(
                    source.clone(),
                    Source {
                        key: 0,
                        path: source.clone(),
                        identity: Some(identity(source)?),
                        disk: Some(text.clone()),
                        text: text.clone(),
                        after: text,
                        document: None,
                        edits: vec![],
                    },
                );
            }
            Err(error) => issues.push(format!("{}: {error}", label(&root, source))),
        }
    }
    let named = documents.named_documents();
    for tab in &checkpoint.tabs {
        let original = documents.document_path(tab.document).map_err(failure)?;
        let Some(original) = original else { continue };
        if !root.contains(&original) {
            continue;
        }
        let real = fs::canonicalize(&original)
            .or_else(|_| projected(&original).map_err(std::io::Error::other))
            .map_err(|e| e.to_string())?;
        if tab.contents.len() > FILE_LIMIT {
            issues.push(format!(
                "{}: open note exceeds 4 MiB.",
                label(&root, &original)
            ));
            continue;
        }
        if let Some(source) = sources.get_mut(&real) {
            source.path = original;
            source.text = tab.contents.clone();
            source.after = tab.contents.clone();
            source.document = Some(tab.document);
        } else if !real.exists() {
            sources.insert(
                real,
                Source {
                    key: 0,
                    path: original,
                    identity: None,
                    disk: None,
                    text: tab.contents.clone(),
                    after: tab.contents.clone(),
                    document: Some(tab.document),
                    edits: vec![],
                },
            );
        } else {
            match read(&real) {
                Ok(disk) => {
                    used += disk.len();
                    sources.insert(
                        real.clone(),
                        Source {
                            key: 0,
                            path: original,
                            identity: Some(identity(&real)?),
                            disk: Some(disk),
                            text: tab.contents.clone(),
                            after: tab.contents.clone(),
                            document: Some(tab.document),
                            edits: vec![],
                        },
                    );
                }
                Err(error) => issues.push(format!("{}: {error}", original.display())),
            }
        }
    }
    let target_real = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !sources.contains_key(&target_real) {
        match read(&target_real) {
            Ok(text) => {
                used += text.len();
                sources.insert(
                    target_real.clone(),
                    Source {
                        key: 0,
                        path: path.into(),
                        identity: Some(target_identity.clone()),
                        disk: Some(text.clone()),
                        text: text.clone(),
                        after: text,
                        document: None,
                        edits: vec![],
                    },
                );
            }
            Err(error) => issues.push(format!("{}: {error}", path.display())),
        }
    }
    if used > TOTAL_LIMIT {
        issues.push("The rename snapshot exceeds 16 MiB; link updates are disabled.".into());
    }
    for (key, source) in sources.values_mut().enumerate() {
        source.key = key;
    }
    let old_real = if let Some(old) = old {
        projected(&old.from)?
    } else {
        fs::canonicalize(path).map_err(|e| e.to_string())?
    };
    let mut prior_links = BTreeMap::new();
    if let Some(old) = old {
        for step in &old.steps {
            if !step.done {
                prior_links.insert(
                    fs::canonicalize(&step.path)
                        .or_else(|_| projected(&step.path).map_err(std::io::Error::other))
                        .unwrap_or(step.path.clone()),
                    removed_links(&step.before, &step.after),
                );
            }
        }
        for (before, after) in old.before.tabs.iter().zip(&old.after.tabs) {
            if before.contents != after.contents
                && let Some((path, _)) = &after.original
            {
                prior_links.insert(
                    fs::canonicalize(path)
                        .or_else(|_| projected(path).map_err(std::io::Error::other))
                        .unwrap_or(path.clone()),
                    removed_links(&before.contents, &after.contents),
                );
            }
        }
    }
    Ok(Plan {
        token: token(),
        root,
        from: old.map_or_else(|| path.to_path_buf(), |old| old.from.clone()),
        target: path.to_path_buf(),
        to,
        old_real,
        target_identity,
        sources: sources.into_values().collect(),
        paths,
        named,
        checkpoint,
        issues,
        finalized: false,
        retry: old.is_some(),
        prior_links,
    })
}

// Classify against the pre-rename target and its proposed spelling. Comparing
// projected paths first also handles case-only renames before the disk mutation.
#[derive(PartialEq)]
enum Target {
    Old,
    New,
    Other,
}
fn target(plan: &Plan, documents: &Documents, source: &Path, path: &str, wiki: bool) -> Target {
    let Ok(paths) =
        crate::note_links::candidates(Some(&plan.root), Some(source), path, wiki, &EXTENSIONS)
    else {
        return Target::Other;
    };
    let Ok(new_real) = projected(&plan.to) else {
        return Target::Other;
    };
    for path in paths {
        let normalized = projected(&path).ok();
        if normalized.as_ref() == Some(&new_real) {
            return Target::New;
        }
        if plan.retry
            && normalized.as_ref() == Some(&plan.old_real)
            && fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            return Target::Old;
        }
        if let Ok(real) = fs::canonicalize(&path)
            && real.is_file()
            && (plan.root.contains(&real)
                || documents.chosen(&real)
                || documents.granted_path_for(&real).is_some())
        {
            return if identity(&real).ok().as_ref() == Some(&plan.target_identity) {
                Target::Old
            } else {
                Target::Other
            };
        }
    }
    Target::Other
}
fn classify(
    plan: &Plan,
    documents: &Documents,
    source: &Path,
    text: &str,
) -> Result<(usize, usize), String> {
    let mut old = 0;
    let mut new = 0;
    for (path, wiki) in backlinks::outgoing(text)? {
        if wiki && notes::link_id(&path).is_some() {
            continue;
        }
        match target(plan, documents, source, &path, wiki) {
            Target::Old => old += 1,
            Target::New => new += 1,
            _ => {}
        }
    }
    Ok((old, new))
}
fn finalize(
    plan: &mut Plan,
    documents: &Documents,
    candidates: Vec<Candidates>,
) -> Result<Preview, String> {
    let mut all: BTreeMap<_, _> = candidates
        .into_iter()
        .map(|file| (file.key, file.spans))
        .collect();
    let scan = backlinks::inventory(&plan.root, 100_000);
    let mut sources = std::mem::take(&mut plan.sources);
    for source in &mut sources {
        let spans = all
            .remove(&source.key)
            .ok_or("The parser did not return every source. Rebuild the preview.")?;
        let before = match classify(plan, documents, &source.path, &source.text) {
            Ok(value) => value,
            Err(error) => {
                plan.issues
                    .push(format!("{}: {error}", source.path.display()));
                continue;
            }
        };
        let real = fs::canonicalize(&source.path)
            .or_else(|_| projected(&source.path).map_err(std::io::Error::other))
            .unwrap_or(source.path.clone());
        if let Some(prior) = plan.prior_links.get(&real) {
            for link in backlinks::outgoing(&source.text)? {
                if prior.contains(&link)
                    && target(plan, documents, &source.path, &link.0, link.1) == Target::Other
                {
                    plan.issues.push(format!("{}: a pending destination changed or cannot be resolved safely; review it manually before bulk retry.", source.path.display()));
                }
            }
        }
        let (allowed, excluded) = guards(&source.text);
        for span in spans {
            let from = byte_at(&source.text, span.from)?;
            let to = byte_at(&source.text, span.to)?;
            let raw = source
                .text
                .get(from..to)
                .ok_or("An invalid destination span was returned.")?;
            let url = if span.wiki {
                raw.to_owned()
            } else {
                unescape(raw)
            };
            let Some(path) = backlinks::link_path(&url) else {
                continue;
            };
            if !allowed_span(&source.text, &span, from, to, &path, &allowed, &excluded) {
                continue;
            }
            if span.wiki
                && let Some(id) = notes::link_id(&path)
            {
                if scan.ids.get(id).is_some_and(|paths| paths.len() > 1) {
                    plan.issues.push(format!(
                        "Ambiguous ID {id}; resolve duplicates before bulk updates."
                    ));
                }
                continue;
            }
            if target(plan, documents, &source.path, &path, span.wiki) != Target::Old {
                continue;
            }
            if span.reference
                && !backlinks::outgoing(&source.text)?
                    .iter()
                    .any(|(p, w)| !w && p == &path)
            {
                continue;
            }
            let parent = fs::canonicalize(source.path.parent().ok_or("No source folder.")?)
                .map_err(|e| e.to_string())?;
            let mut replacement = relative(&parent, &projected(&plan.to)?)?;
            if span.wiki
                && Path::new(&path).extension().is_none()
                && replacement.to_ascii_lowercase().ends_with(".md")
            {
                replacement.truncate(replacement.len() - 3);
            }
            let hash = raw.find('#').unwrap_or(raw.len());
            let mut insert = encode(&replacement) + &raw[hash..];
            if span.wiki && !source.text[to..].trim_start().starts_with('|') {
                insert.push('|');
                insert.push_str(raw);
            }
            if insert != raw {
                source.edits.push(RawEdit {
                    from,
                    to,
                    before: raw.into(),
                    insert,
                });
            }
        }
        source.edits.sort_by_key(|edit| edit.from);
        if source
            .edits
            .windows(2)
            .any(|pair| pair[0].to > pair[1].from)
        {
            return Err("Overlapping link edits were refused.".into());
        }
        source.after = source.text.clone();
        for edit in source.edits.iter().rev() {
            source.after.replace_range(edit.from..edit.to, &edit.insert);
        }
        let after = classify(plan, documents, &source.path, &source.after)?;
        if after.0 != 0 || after.1 < before.0 + before.1 {
            plan.issues.push(format!(
                "{}: not every parsed link could be safely rewritten.",
                label(&plan.root, &source.path)
            ));
        }
        if !source.edits.is_empty() && source.document.is_none() {
            let meta = fs::metadata(&source.path).map_err(|e| e.to_string())?;
            if meta.permissions().readonly() {
                plan.issues
                    .push(format!("{} is read-only.", source.path.display()));
            }
            if hard_linked(&source.path)? {
                plan.issues.push(format!(
                    "{} has hard links; it cannot be atomically rewritten safely.",
                    source.path.display()
                ));
            }
        }
    }
    plan.sources = sources;
    plan.finalized = true;
    Ok(Preview {
        token: plan.token.clone(),
        from: plan.from.to_string_lossy().into_owned(),
        to: plan.to.to_string_lossy().into_owned(),
        files: plan
            .sources
            .iter()
            .filter(|source| !source.edits.is_empty())
            .map(|source| PreviewFile {
                path: source.path.to_string_lossy().into_owned(),
                label: label(&plan.root, &source.path),
                editor: source.document.is_some(),
                edits: editor_edits(source),
            })
            .collect(),
        issues: plan.issues.clone(),
        retry: plan.retry,
    })
}

fn preflight(
    plan: &Plan,
    documents: &Documents,
    checkpoint: &Checkpoint,
    update: bool,
) -> Result<(), String> {
    let root = documents
        .root()
        .ok_or("The workspace closed. Rebuild the preview.")?;
    if root.link_base() != plan.root.link_base()
        || root.watch_path() != plan.root.watch_path()
        || !root.contains(root.link_base())
    {
        return Err("The workspace changed. Rebuild the preview.".into());
    }
    if !root.contains(&plan.target)
        || !root.contains(&plan.to)
        || !fs::symlink_metadata(&plan.target)
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
    {
        return Err("The target's location or file type changed. Rebuild the preview.".into());
    }
    if !same_checkpoint(&plan.checkpoint, checkpoint) || documents.named_documents() != plan.named {
        return Err("Editor contents or open tabs changed. Rebuild the preview.".into());
    }
    if identity(&plan.target)? != plan.target_identity {
        return Err("The target note changed identity. Rebuild the preview.".into());
    }
    if fs::symlink_metadata(&plan.to).is_ok() && identity(&plan.to)? != plan.target_identity {
        return Err("The destination now exists. No files were changed.".into());
    }
    if update {
        if !plan.finalized || !plan.issues.is_empty() {
            return Err(
                "The preview is incomplete or blocked. Use Rename Only or fix the reported issues."
                    .into(),
            );
        }
        let scan = backlinks::inventory(&root, 100_000);
        if !scan.complete || !scan.warnings.is_empty() || scan.paths != plan.paths {
            return Err("Workspace files changed. Rebuild the preview.".into());
        }
        for source in &plan.sources {
            if !root.contains(&source.path) {
                return Err("A source left the workspace.".into());
            }
            match (&source.disk, &source.identity) {
                (Some(bytes), Some(stamp))
                    if identity(&source.path)? == *stamp && read(&source.path)? == *bytes => {}
                (None, None) if fs::symlink_metadata(&source.path).is_err() => {}
                _ => {
                    return Err(format!(
                        "{} changed. Rebuild the preview.",
                        label(&root, &source.path)
                    ));
                }
            }
            if source.document.is_none() && !source.edits.is_empty() {
                if hard_linked(&source.path)? {
                    return Err("A source acquired hard links. Rebuild the preview.".into());
                }
                fs::OpenOptions::new()
                    .append(true)
                    .open(&source.path)
                    .map_err(|e| format!("{}: {e}", source.path.display()))?;
            }
        }
    }
    Ok(())
}
fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(recovery::session_path(app)?.with_file_name("rename.json"))
}
fn store(path: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(
            "The rename recovery record exceeds 64 MiB. No further changes were applied.".into(),
        );
    }
    let parent = path.parent().ok_or("No journal directory.")?;
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::Builder::new()
        .prefix(".rename-")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}
fn load(path: &Path) -> Result<Option<Journal>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Rename recovery record exceeds its size limit.".into());
    }
    let mut journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Rename recovery is unreadable: {e}"))?;
    if journal.version != 1
        || !journal.from.is_absolute()
        || !journal.to.is_absolute()
        || journal.from.parent() != journal.to.parent()
    {
        return Err("Rename recovery metadata is unsupported or invalid.".into());
    }
    recovery::validate(&journal.before)?;
    recovery::validate(&journal.after)?;
    if journal.before.tabs.len() != journal.after.tabs.len()
        || journal.before.closed
        || journal.after.closed
    {
        return Err("Rename recovery snapshots do not agree.".into());
    }
    // Receipt identities survive an interruption before the final progress
    // checkpoint. Recognize completion without replaying a source write.
    for item in &mut journal.steps {
        if !item.done
            && item
                .replacement
                .as_ref()
                .is_some_and(|receipt| identity(&item.path).ok().as_ref() == Some(receipt))
        {
            item.done = true;
        }
    }
    Ok(Some(journal))
}
fn verified_new(journal: &Journal) -> bool {
    let Ok(current) = identity(&journal.to) else {
        return false;
    };
    current == journal.target_identity
        || journal
            .steps
            .iter()
            .any(|step| step.path == journal.to && step.replacement.as_ref() == Some(&current))
}
fn outcome(
    journal: &Journal,
    renamed: Option<workspace::Renamed>,
    patches: Vec<OpenPatch>,
) -> Outcome {
    let label = |path: &Path| {
        path.strip_prefix(&journal.root_given)
            .or_else(|_| path.strip_prefix(&journal.root_real))
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    };
    Outcome {
        token: journal.token.clone(),
        renamed,
        patches,
        written: journal.steps.iter().filter(|s| s.done).count(),
        pending: journal.steps.iter().filter(|s| !s.done).count(),
        error: journal.error.clone(),
        rename_done: journal.renamed,
        written_files: journal
            .steps
            .iter()
            .filter(|s| s.done)
            .map(|s| label(&s.path))
            .collect(),
        pending_files: journal
            .steps
            .iter()
            .filter(|s| !s.done)
            .map(|s| label(&s.path))
            .collect(),
        editor_files: journal
            .after
            .tabs
            .iter()
            .zip(&journal.before.tabs)
            .filter(|(a, b)| a.contents != b.contents)
            .filter_map(|(a, _)| a.original.as_ref().map(|(path, _)| label(path)))
            .collect(),
    }
}

fn after_session(plan: &Plan, before: &Session, checkpoint: &Checkpoint, update: bool) -> Session {
    let mut after = before.clone();
    let target_real = fs::canonicalize(&plan.target).ok();
    for (tab, editor) in after.tabs.iter_mut().zip(&checkpoint.tabs) {
        if let Some((path, _)) = &mut tab.original
            && fs::canonicalize(&*path).ok() == target_real
        {
            *path = plan.to.clone();
        }
        if update
            && let Some(source) = plan
                .sources
                .iter()
                .find(|source| source.document == Some(editor.document) && !source.edits.is_empty())
        {
            tab.contents = source.after.clone();
            tab.dirty = true;
            let edits = editor_edits(source);
            let map = |position: usize| {
                let mut shift: isize = 0;
                for edit in &edits {
                    if position < edit.from {
                        break;
                    }
                    if position <= edit.to {
                        return (edit.from as isize + shift) as usize
                            + edit.insert.encode_utf16().count();
                    }
                    shift += edit.insert.encode_utf16().count() as isize
                        - (edit.to - edit.from) as isize;
                }
                (position as isize + shift).max(0) as usize
            };
            tab.anchor = map(tab.anchor);
            tab.head = map(tab.head);
            // Selection mapping is performed by CodeMirror during live apply;
            // recovery clamps these prior offsets to the recovered text.
        }
    }
    after
}
fn begin(
    plan: &Plan,
    documents: &Documents,
    checkpoint: Checkpoint,
    update: bool,
    path: &Path,
    session_path: &Path,
) -> Result<Outcome, String> {
    preflight(plan, documents, &checkpoint, update)?;
    let before = recovery::capture(documents, checkpoint.clone())?;
    let after = after_session(plan, &before, &checkpoint, update);
    recovery::store(session_path, &before)?;
    let mut journal = Journal {
        version: 1,
        token: plan.token.clone(),
        root_given: plan.root.link_base().into(),
        root_real: plan.root.watch_path().into(),
        from: plan.from.clone(),
        to: plan.to.clone(),
        target_identity: plan.target_identity.clone(),
        before,
        after,
        steps: if update {
            plan.sources
                .iter()
                .filter(|source| source.document.is_none() && !source.edits.is_empty())
                .map(|source| Step {
                    path: if fs::canonicalize(&source.path).ok()
                        == fs::canonicalize(&plan.target).ok()
                    {
                        plan.to.clone()
                    } else {
                        source.path.clone()
                    },
                    before: source.disk.clone().unwrap(),
                    after: source.after.clone(),
                    identity: source.identity.clone().unwrap(),
                    replacement: None,
                    done: false,
                })
                .collect()
        } else {
            vec![]
        },
        renamed: plan.retry,
        error: None,
        named: documents.named_documents(),
    };
    store(path, &journal)?;
    let renamed = if plan.retry {
        workspace::Renamed {
            path: plan.to.to_string_lossy().into_owned(),
            documents: vec![],
        }
    } else {
        match workspace::rename(
            documents,
            &plan.root,
            &plan.target,
            plan.to
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("Invalid destination filename.")?,
        ) {
            Ok(renamed) => renamed,
            Err(error) => {
                journal.error = Some(error.clone());
                let _ = store(path, &journal);
                return Err(format!("Rename failed; no links were changed. {error}"));
            }
        }
    };
    journal.renamed = true;
    journal.named = documents.named_documents();
    // Use the paths actually assigned by native rename, including aliases.
    for (tab, editor) in journal.after.tabs.iter_mut().zip(&checkpoint.tabs) {
        if let Some((_, destination)) = renamed
            .documents
            .iter()
            .find(|(id, _)| *id == editor.document)
            && let Some((path, _)) = &mut tab.original
        {
            *path = destination.into();
        }
    }
    let patches = if update {
        plan.sources
            .iter()
            .filter_map(|source| {
                source
                    .document
                    .filter(|_| !source.edits.is_empty())
                    .map(|document| OpenPatch {
                        document,
                        edits: editor_edits(source),
                    })
            })
            .collect()
    } else {
        vec![]
    };
    if let Err(error) =
        store(path, &journal).and_then(|_| recovery::store(session_path, &journal.after))
    {
        journal.error = Some(format!(
            "The note was renamed, but recovery checkpointing stopped further work: {error}"
        ));
        let _ = store(path, &journal);
    }
    Ok(outcome(&journal, Some(renamed), patches))
}
fn step(documents: &Documents, path: &Path, token: &str) -> Result<Outcome, String> {
    let mut journal = load(path)?.ok_or("No rename operation is pending.")?;
    if journal.token != token {
        return Err("The rename operation changed.".into());
    }
    let root = documents
        .root()
        .ok_or("The workspace closed. Review remaining work before continuing.")?;
    if root.link_base() != journal.root_given
        || root.watch_path() != journal.root_real
        || !root.contains(root.link_base())
    {
        return Err("The workspace changed. Remaining files were not changed.".into());
    }
    if journal.error.is_some() {
        return Ok(outcome(&journal, None, vec![]));
    }
    if documents.named_documents() != journal.named {
        journal.error =
            Some("Open tabs changed. Review remaining updates before continuing.".into());
        store(path, &journal)?;
        return Ok(outcome(&journal, None, vec![]));
    }
    if !root.contains(&journal.to) {
        journal.error =
            Some("The renamed note left the workspace. Remaining updates stopped.".into());
        store(path, &journal)?;
        return Ok(outcome(&journal, None, vec![]));
    }
    if !verified_new(&journal) {
        journal.error =
            Some("The renamed note's identity changed. Remaining updates stopped.".into());
        store(path, &journal)?;
        return Ok(outcome(&journal, None, vec![]));
    }
    for item in &journal.steps {
        if !root.contains(&item.path) {
            journal.error =
                Some("A reviewed source left the workspace. Remaining updates stopped.".into());
            store(path, &journal)?;
            return Ok(outcome(&journal, None, vec![]));
        }
        let expected = if item.done { &item.after } else { &item.before };
        let expected_id = if item.done {
            item.replacement.as_ref().unwrap_or(&item.identity)
        } else {
            &item.identity
        };
        let current_id = identity(&item.path).ok();
        let completed_receipt = !item.done
            && item
                .replacement
                .as_ref()
                .is_some_and(|id| current_id.as_ref() == Some(id));
        if !completed_receipt
            && (current_id.as_ref() != Some(expected_id)
                || read(&item.path).ok().as_ref() != Some(expected))
        {
            journal.error = Some(format!(
                "{} changed outside Textgate. Remaining updates stopped.",
                item.path.display()
            ));
            store(path, &journal)?;
            return Ok(outcome(&journal, None, vec![]));
        }
    }
    let Some(index) = journal.steps.iter().position(|step| !step.done) else {
        return Ok(outcome(&journal, None, vec![]));
    };
    let item = journal.steps[index].clone();
    let result = (|| -> Result<(), String> {
        if hard_linked(&item.path)? {
            return Err("A source has hard links. Remaining updates stopped.".into());
        }
        if !root.contains(&item.path) {
            return Err("A remaining source is no longer inside the workspace.".into());
        }
        if documents
            .named_documents()
            .iter()
            .any(|(_, path)| fs::canonicalize(path).ok() == fs::canonicalize(&item.path).ok())
        {
            return Err("A previously closed source is now open. Rebuild its preview instead of writing through the editor.".into());
        }
        let current = read(&item.path)?;
        let stamp = identity(&item.path)?;
        if item.replacement.as_ref() == Some(&stamp) {
            journal.steps[index].done = true;
            store(path, &journal)?;
            return Ok(());
        }
        if current != item.before || stamp != item.identity {
            return Err(format!(
                "{} changed outside Textgate. Remaining updates stopped.",
                item.path.display()
            ));
        }
        documents::save_with_receipt(
            &item.path,
            item.after.as_bytes(),
            Some(item.before.as_bytes()),
            |temporary| {
                if !root.contains(&item.path) {
                    return Err(io_failure(
                        "The source left the workspace before replacement.".into(),
                    ));
                }
                journal.steps[index].replacement = Some(identity(temporary).map_err(io_failure)?);
                store(path, &journal).map_err(io_failure)
            },
        )
        .map_err(failure)?;
        journal.steps[index].done = true;
        store(path, &journal)
    })();
    if let Err(error) = result {
        journal.error = Some(error);
        store(path, &journal)?;
    }
    Ok(outcome(&journal, None, vec![]))
}

// Called before normal session restoration. Never replay filesystem writes.
// A prepared record can cover a crash between the rename and its receipt.
pub(crate) fn reconcile(app: &tauri::AppHandle, session: Session) -> (Session, Vec<String>) {
    reconcile_journal(session, journal_path(app).and_then(|path| load(&path)))
}
pub(crate) fn recovery_seed(app: &tauri::AppHandle) -> Result<Option<Session>, String> {
    Ok(load(&journal_path(app)?)?.map(|journal| journal.before))
}
fn reconcile_journal(
    mut session: Session,
    journal: Result<Option<Journal>, String>,
) -> (Session, Vec<String>) {
    match journal {
        Ok(Some(journal)) => {
            let mut warnings = vec!["An unfinished rename has a durable progress record. Review it before retrying; no pending file writes were replayed.".into()];
            if verified_new(&journal) {
                if session == journal.before {
                    session = journal.after.clone();
                } else {
                    for tab in &mut session.tabs {
                        if let Some((path, baseline)) = &mut tab.original {
                            let previous = journal.before.tabs.iter().find(|old| {
                                old.original.as_ref().is_some_and(|(old_path, bytes)| {
                                    old_path == path && bytes == baseline
                                })
                            });
                            if let Some(previous) = previous
                                && let Some(index) = journal
                                    .before
                                    .tabs
                                    .iter()
                                    .position(|old| std::ptr::eq(old, previous))
                                && let Some((mapped, _)) = &journal.after.tabs[index].original
                            {
                                *path = mapped.clone();
                            }
                        }
                    }
                }
            } else if identity(&journal.from).ok().as_ref() != Some(&journal.target_identity) {
                let mut uncertain = BTreeSet::from([journal.from.clone(), journal.to.clone()]);
                for (before, after) in journal.before.tabs.iter().zip(&journal.after.tabs) {
                    if let (Some((old, _)), Some((new, _))) = (&before.original, &after.original)
                        && old != new
                    {
                        uncertain.insert(old.clone());
                        uncertain.insert(new.clone());
                    }
                }
                for tab in &mut session.tabs {
                    if !session.closed
                        && tab
                            .original
                            .as_ref()
                            .is_some_and(|(path, _)| uncertain.contains(path))
                    {
                        tab.original = None;
                        tab.dirty = true;
                    }
                }
                warnings.push("The renamed note's file identity could not be verified. Its recoverable drafts were kept as Untitled; inspect the files before retrying.".into());
            }
            (session, warnings)
        }
        Err(error) => {
            for tab in &mut session.tabs {
                if !session.closed
                    && tab
                        .original
                        .as_ref()
                        .is_some_and(|(path, _)| !path.is_file())
                {
                    tab.original = None;
                    tab.dirty = true;
                }
            }
            (
                session,
                vec![format!(
                    "Rename recovery could not be verified. Missing-path drafts were kept as Untitled. {error}"
                )],
            )
        }
        Ok(None) => (session, vec![]),
    }
}

#[tauri::command]
pub async fn prepare_note_rename(
    app: tauri::AppHandle,
    path: PathBuf,
    name: String,
    checkpoint: Checkpoint,
) -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if load(&journal_path(&app)?)?.is_some() {
            return Err("Review or acknowledge the previous rename operation first.".into());
        }
        let plan = prepare(&app.state::<Documents>(), &path, &name, checkpoint, None)?;
        let scan = Scan {
            token: plan.token.clone(),
            sources: plan
                .sources
                .iter()
                .map(|s| ParseSource {
                    key: s.key,
                    text: s.text.clone(),
                })
                .collect(),
        };
        *app.state::<Renames>().0.lock().unwrap() = Some(plan);
        Ok(scan)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn preview_note_rename(
    app: tauri::AppHandle,
    token: String,
    candidates: Vec<Candidates>,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<Renames>();
        let mut state = manager.0.lock().unwrap();
        let plan = state
            .as_mut()
            .filter(|p| p.token == token)
            .ok_or("The rename preview expired.")?;
        finalize(plan, &app.state::<Documents>(), candidates)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn begin_note_rename(
    app: tauri::AppHandle,
    token: String,
    checkpoint: Checkpoint,
    update: bool,
) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recovery = app.state::<recovery::Recovery>();
        let ready = recovery.ready.lock().unwrap();
        if !*ready {
            return Err("Recovery must be available before a multi-file rename.".into());
        }
        let manager = app.state::<Renames>();
        let state = manager.0.lock().unwrap();
        let plan = state
            .as_ref()
            .filter(|p| p.token == token)
            .ok_or("The rename preview expired.")?;
        begin(
            plan,
            &app.state::<Documents>(),
            checkpoint,
            update,
            &journal_path(&app)?,
            &recovery::session_path(&app)?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn step_note_rename(app: tauri::AppHandle, token: String) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        step(&app.state::<Documents>(), &journal_path(&app)?, &token)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pending_note_rename(app: tauri::AppHandle) -> Result<Option<Pending>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(load(&journal_path(&app)?)?.map(|j| {
            let renamed = j.renamed || verified_new(&j);
            Pending {
                token: j.token,
                from: j.from.to_string_lossy().into_owned(),
                to: j.to.to_string_lossy().into_owned(),
                written: j.steps.iter().filter(|s| s.done).count(),
                pending: j.steps.iter().filter(|s| !s.done).count(),
                error: j.error,
                rename_done: renamed,
                documents: app
                    .state::<Documents>()
                    .named_documents()
                    .into_iter()
                    .map(|(id, path)| (id, path.to_string_lossy().into_owned()))
                    .collect(),
            }
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn acknowledge_note_rename(app: tauri::AppHandle, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = journal_path(&app)?;
        let journal = load(&path)?.ok_or("No rename record is pending.")?;
        if journal.token != token {
            return Err("The rename record changed.".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn retry_note_rename(
    app: tauri::AppHandle,
    token: String,
    checkpoint: Checkpoint,
) -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let old = load(&journal_path(&app)?)?.filter(|j| j.token == token).ok_or("The rename record changed.")?;
        let documents = app.state::<Documents>(); let root = documents.root().ok_or("Reopen the operation's workspace first.")?;
        if root.link_base() != old.root_given || root.watch_path() != old.root_real { return Err("Reopen the operation's workspace before reviewing remaining updates.".into()); }
        let renamed = verified_new(&old);
        let path = if renamed { &old.to } else if identity(&old.from).ok().as_ref() == Some(&old.target_identity) { &old.from } else { return Err("The renamed note's identity cannot be verified. Keep recovery drafts and resolve the files manually.".into()); };
        let plan = prepare(&documents, path, old.to.file_name().and_then(|s| s.to_str()).ok_or("Invalid destination.")?, checkpoint, renamed.then_some(&old))?;
        let scan = Scan { token: plan.token.clone(), sources: plan.sources.iter().map(|s| ParseSource { key: s.key, text: s.text.clone() }).collect() };
        *app.state::<Renames>().0.lock().unwrap() = Some(plan); Ok(scan)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::CheckpointTab;
    fn checkpoint(tabs: Vec<(DocumentId, String, bool)>) -> Checkpoint {
        Checkpoint {
            tabs: tabs
                .into_iter()
                .map(|(document, contents, dirty)| CheckpointTab {
                    document,
                    contents,
                    dirty,
                    anchor: 0,
                    head: 0,
                })
                .collect(),
            active: 0,
            closed: false,
        }
    }
    fn setup(path: &Path) -> Documents {
        let docs = Documents::default();
        docs.set_root(Some(Root::new(path).unwrap()));
        docs
    }
    fn spans(plan: &Plan, values: &[(&str, bool, bool)]) -> Vec<Candidates> {
        plan.sources
            .iter()
            .map(|source| Candidates {
                key: source.key,
                spans: values
                    .iter()
                    .filter_map(|(value, wiki, reference)| {
                        source.text.find(value).map(|from| Span {
                            from: source.text[..from].encode_utf16().count(),
                            to: source.text[..from + value.len()].encode_utf16().count(),
                            wiki: *wiki,
                            reference: *reference,
                        })
                    })
                    .collect(),
            })
            .collect()
    }
    #[test]
    fn preview_preserves_ids_aliases_fragments_bom_and_mixed_endings_and_writes_only_after_rename()
    {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("202611071530 Old.md");
        fs::write(&old, "# Old\n").unwrap();
        let source = dir.path().join("source.md");
        let text = "\u{feff}[Label](<202611071530%20Old.md#part> \"title\")\r\n[[202611071530 Old|Stable]]\n[[202611071530 Old.md#part|Alias]]\r\n`202611071530 Old.md`\n";
        fs::write(&source, text).unwrap();
        let cp = checkpoint(vec![]);
        let mut plan = prepare(&docs, &old, "202611071530 New.md", cp.clone(), None).unwrap();
        let candidates = spans(
            &plan,
            &[
                ("202611071530%20Old.md#part", false, false),
                ("202611071530 Old", true, false),
                ("202611071530 Old.md#part", true, false),
            ],
        );
        let preview = finalize(&mut plan, &docs, candidates).unwrap();
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        assert_eq!(preview.files.len(), 1);
        assert_eq!(fs::read_to_string(&source).unwrap(), text);
        assert!(old.exists());
        let journal = dir.path().join("private/rename.json");
        let session = dir.path().join("private/session.json");
        let begun = begin(&plan, &docs, cp, true, &journal, &session).unwrap();
        assert_eq!(begun.pending, 1);
        assert!(!old.exists());
        assert!(plan.to.exists());
        assert_eq!(fs::read_to_string(&source).unwrap(), text);
        let result = step(&docs, &journal, &plan.token).unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(result.pending, 0);
        let after = fs::read_to_string(&source).unwrap();
        assert_eq!(
            after,
            text.replace("202611071530%20Old.md#part", "202611071530%20New.md#part")
                .replace(
                    "[[202611071530 Old.md#part|Alias]]",
                    "[[202611071530%20New.md#part|Alias]]"
                )
        );
        let record = load(&journal).unwrap().unwrap();
        assert!(record.steps[0].replacement.is_some());
    }
    #[test]
    fn unsaved_sources_get_editor_patches_and_durable_drafts_without_disk_writes() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        fs::write(&old, "# Old").unwrap();
        let source = dir.path().join("source.md");
        fs::write(&source, "on disk").unwrap();
        let id = docs
            .restore_recovery(
                Some((source.clone(), Some(b"on disk".to_vec()))),
                "unsaved [[Old]]",
                true,
            )
            .unwrap()
            .0;
        let cp = checkpoint(vec![(id, "unsaved [[Old]]".into(), true)]);
        let mut plan = prepare(&docs, &old, "New.md", cp.clone(), None).unwrap();
        let candidates = spans(&plan, &[("Old", true, false)]);
        let preview = finalize(&mut plan, &docs, candidates).unwrap();
        assert!(preview.issues.is_empty());
        assert!(preview.files[0].editor);
        let journal = dir.path().join("private/rename.json");
        let result = begin(
            &plan,
            &docs,
            cp,
            true,
            &journal,
            &dir.path().join("private/session.json"),
        )
        .unwrap();
        assert_eq!(result.patches.len(), 1);
        assert_eq!(result.patches[0].edits[0].insert, "New|Old");
        assert_eq!(fs::read_to_string(source).unwrap(), "on disk");
        let record = load(&journal).unwrap().unwrap();
        assert_eq!(record.after.tabs[0].contents, "unsaved [[New|Old]]");
        assert!(record.after.tabs[0].dirty);
    }
    #[test]
    fn stale_source_or_new_destination_prevents_all_mutations() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        fs::write(&old, "old").unwrap();
        let source = dir.path().join("source.md");
        fs::write(&source, "[[Old]]").unwrap();
        let cp = checkpoint(vec![]);
        let mut plan = prepare(&docs, &old, "New.md", cp.clone(), None).unwrap();
        let candidates = spans(&plan, &[("Old", true, false)]);
        finalize(&mut plan, &docs, candidates).unwrap();
        fs::write(&source, "outside edit").unwrap();
        let journal = dir.path().join("private/rename.json");
        let session = dir.path().join("private/session.json");
        assert!(begin(&plan, &docs, cp.clone(), true, &journal, &session).is_err());
        assert!(old.exists());
        assert!(!journal.exists());
        fs::write(&source, "[[Old]]").unwrap();
        fs::write(&plan.to, "keep").unwrap();
        assert!(begin(&plan, &docs, cp, true, &journal, &session).is_err());
        assert_eq!(fs::read_to_string(&plan.to).unwrap(), "keep");
        assert!(old.exists());
    }
    #[test]
    fn rename_only_leaves_links_untouched_and_partial_failures_stop_before_pending_files() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        fs::write(&old, "old").unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "[[Old]]").unwrap();
        fs::write(&b, "[[Old]]").unwrap();
        let cp = checkpoint(vec![]);
        let mut plan = prepare(&docs, &old, "New.md", cp.clone(), None).unwrap();
        let candidates = spans(&plan, &[("Old", true, false)]);
        finalize(&mut plan, &docs, candidates).unwrap();
        let journal = dir.path().join("private/rename.json");
        let session = dir.path().join("private/session.json");
        let result = begin(&plan, &docs, cp, true, &journal, &session).unwrap();
        assert_eq!(result.pending, 2);
        fs::write(&a, "external new text").unwrap();
        let result = step(&docs, &journal, &plan.token).unwrap();
        assert!(result.error.is_some());
        assert_eq!(result.pending, 2);
        assert_eq!(fs::read_to_string(&b).unwrap(), "[[Old]]");
        // Rename Only is independently permitted despite a blocked update scan.
        let another = dir.path().join("Another.md");
        fs::write(&another, "another").unwrap();
        let mut only = prepare(&docs, &another, "Renamed.md", checkpoint(vec![]), None).unwrap();
        only.issues.push("blocked".into());
        begin(
            &only,
            &docs,
            checkpoint(vec![]),
            false,
            &dir.path().join("private/only.json"),
            &session,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(b).unwrap(), "[[Old]]");
    }
    #[test]
    fn opening_a_source_between_steps_stops_disk_updates() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        let source = dir.path().join("source.md");
        fs::write(&old, "target").unwrap();
        fs::write(&source, "[[Old]]").unwrap();
        let cp = checkpoint(vec![]);
        let mut plan = prepare(&docs, &old, "New.md", cp.clone(), None).unwrap();
        let candidates = spans(&plan, &[("Old", true, false)]);
        finalize(&mut plan, &docs, candidates).unwrap();
        let journal = dir.path().join("private/rename.json");
        begin(
            &plan,
            &docs,
            cp,
            true,
            &journal,
            &dir.path().join("private/session.json"),
        )
        .unwrap();
        docs.restore_recovery(
            Some((source.clone(), Some(b"[[Old]]".to_vec()))),
            "draft [[Old]]",
            true,
        )
        .unwrap();
        let result = step(&docs, &journal, &plan.token).unwrap();
        assert!(result.error.unwrap().contains("Open tabs changed"));
        assert_eq!(result.pending, 1);
        assert_eq!(fs::read_to_string(source).unwrap(), "[[Old]]");
        assert!(plan.to.exists());
    }
    #[test]
    fn fresh_retry_preserves_outside_edits_and_does_not_repeat_completed_writes() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&old, "target").unwrap();
        fs::write(&a, "[[Old]]").unwrap();
        fs::write(&b, "[[Old]]").unwrap();
        let cp = checkpoint(vec![]);
        let mut plan = prepare(&docs, &old, "New.md", cp.clone(), None).unwrap();
        let candidates = spans(&plan, &[("Old", true, false)]);
        finalize(&mut plan, &docs, candidates).unwrap();
        let journal = dir.path().join("private/rename.json");
        let session = dir.path().join("private/session.json");
        begin(&plan, &docs, cp.clone(), true, &journal, &session).unwrap();
        assert_eq!(step(&docs, &journal, &plan.token).unwrap().written, 1);
        let completed_identity = identity(&a).unwrap();
        fs::write(&b, "outside edit\n[[Old]]").unwrap();
        assert!(step(&docs, &journal, &plan.token).unwrap().error.is_some());
        let record = load(&journal).unwrap().unwrap();
        let mut retry = prepare(&docs, &record.to, "New.md", cp.clone(), Some(&record)).unwrap();
        let candidates = spans(&retry, &[("Old", true, false)]);
        let preview = finalize(&mut retry, &docs, candidates).unwrap();
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        assert_eq!(preview.files.len(), 1);
        assert!(preview.files[0].path.ends_with("b.md"));
        begin(&retry, &docs, cp, true, &journal, &session).unwrap();
        let result = step(&docs, &journal, &retry.token).unwrap();
        assert!(result.error.is_none());
        assert_eq!(result.pending, 0);
        assert_eq!(identity(&a).unwrap(), completed_identity);
        assert_eq!(fs::read_to_string(&a).unwrap(), "[[New|Old]]");
        assert_eq!(fs::read_to_string(&b).unwrap(), "outside edit\n[[New|Old]]");
    }
    #[test]
    fn references_are_rewritten_once_and_unlocated_links_block_bulk_apply() {
        let dir = tempfile::tempdir().unwrap();
        let docs = setup(dir.path());
        let old = dir.path().join("Old.md");
        fs::write(&old, "").unwrap();
        fs::write(
            dir.path().join("source.md"),
            "[A][ref] [B][ref]\n\n[ref]: Old.md \"title\"\n",
        )
        .unwrap();
        let mut plan = prepare(&docs, &old, "New.md", checkpoint(vec![]), None).unwrap();
        let preview = finalize(
            &mut plan,
            &docs,
            vec![
                Candidates {
                    key: 0,
                    spans: vec![],
                },
                Candidates {
                    key: 1,
                    spans: vec![],
                },
            ],
        )
        .unwrap();
        assert!(!preview.issues.is_empty());
        let mut plan = prepare(&docs, &old, "New.md", checkpoint(vec![]), None).unwrap();
        let candidates = spans(&plan, &[("Old.md", false, true)]);
        let preview = finalize(&mut plan, &docs, candidates).unwrap();
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        assert_eq!(preview.files[0].edits.len(), 1);
        assert!(prepare(&docs, &old, "202611071530 New.md", checkpoint(vec![]), None).is_ok());
        let id = dir.path().join("202611071530 ID.md");
        fs::write(&id, "").unwrap();
        assert!(prepare(&docs, &id, "Different.md", checkpoint(vec![]), None).is_err());
    }
}

#[tauri::command]
pub async fn stop_note_rename(
    app: tauri::AppHandle,
    token: String,
    reason: String,
) -> Result<Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = journal_path(&app)?;
        let mut journal = load(&path)?.ok_or("No rename operation is pending.")?;
        if journal.token != token {
            return Err("The rename operation changed.".into());
        }
        journal.error = Some(reason.chars().take(500).collect());
        store(&path, &journal)?;
        Ok(outcome(&journal, None, vec![]))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod interruption_tests {
    use super::*;
    use crate::recovery::CheckpointTab;
    fn open_target(root: &Path) -> (Documents, DocumentId, Checkpoint) {
        let docs = Documents::default();
        docs.set_root(Some(Root::new(root).unwrap()));
        fs::write(root.join("Old.md"), "disk target").unwrap();
        let id = docs
            .restore_recovery(
                Some((root.join("Old.md"), Some(b"disk target".to_vec()))),
                "unsaved target",
                true,
            )
            .unwrap()
            .0;
        let cp = Checkpoint {
            tabs: vec![CheckpointTab {
                document: id,
                contents: "unsaved target".into(),
                dirty: true,
                anchor: 4,
                head: 4,
            }],
            active: 0,
            closed: false,
        };
        (docs, id, cp)
    }
    #[test]
    fn crash_between_rename_and_progress_checkpoint_maps_drafts_without_replaying_writes() {
        let dir = tempfile::tempdir().unwrap();
        let (docs, _, cp) = open_target(dir.path());
        fs::write(dir.path().join("source.md"), "[[Old]]").unwrap();
        let mut plan = prepare(
            &docs,
            &dir.path().join("Old.md"),
            "New.md",
            cp.clone(),
            None,
        )
        .unwrap();
        let candidates = plan
            .sources
            .iter()
            .map(|source| Candidates {
                key: source.key,
                spans: source
                    .text
                    .find("Old")
                    .map(|from| {
                        vec![Span {
                            from,
                            to: from + 3,
                            wiki: true,
                            reference: false,
                        }]
                    })
                    .unwrap_or_default(),
            })
            .collect();
        finalize(&mut plan, &docs, candidates).unwrap();
        let path = dir.path().join("private/rename.json");
        begin(
            &plan,
            &docs,
            cp,
            true,
            &path,
            &dir.path().join("private/session.json"),
        )
        .unwrap();
        let mut journal = load(&path).unwrap().unwrap();
        journal.renamed = false;
        let (recovered, warnings) =
            reconcile_journal(journal.before.clone(), Ok(Some(journal.clone())));
        assert!(!warnings.is_empty());
        assert_eq!(recovered.tabs[0].contents, "unsaved target");
        assert!(
            recovered.tabs[0]
                .original
                .as_ref()
                .unwrap()
                .0
                .ends_with("New.md")
        );
        assert!(!dir.path().join("Old.md").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("source.md")).unwrap(),
            "[[Old]]"
        );
        let mut newer = journal.after.clone();
        newer.tabs[0].contents = "new typing after rename".into();
        let (recovered, _) = reconcile_journal(newer, Ok(Some(journal)));
        assert_eq!(recovered.tabs[0].contents, "new typing after rename");
    }
    #[test]
    fn durable_receipt_recognizes_a_finished_write_without_replacing_it_again() {
        let dir = tempfile::tempdir().unwrap();
        let (docs, _, cp) = open_target(dir.path());
        let source = dir.path().join("source.md");
        fs::write(&source, "[[Old]]").unwrap();
        let mut plan = prepare(
            &docs,
            &dir.path().join("Old.md"),
            "New.md",
            cp.clone(),
            None,
        )
        .unwrap();
        let candidates = plan
            .sources
            .iter()
            .map(|s| Candidates {
                key: s.key,
                spans: s
                    .text
                    .find("Old")
                    .map(|from| {
                        vec![Span {
                            from,
                            to: from + 3,
                            wiki: true,
                            reference: false,
                        }]
                    })
                    .unwrap_or_default(),
            })
            .collect();
        finalize(&mut plan, &docs, candidates).unwrap();
        let path = dir.path().join("private/rename.json");
        begin(
            &plan,
            &docs,
            cp,
            true,
            &path,
            &dir.path().join("private/session.json"),
        )
        .unwrap();
        step(&docs, &path, &plan.token).unwrap();
        let stamp = identity(&source).unwrap();
        let mut journal = load(&path).unwrap().unwrap();
        journal.steps[0].done = false;
        store(&path, &journal).unwrap();
        let result = step(&docs, &path, &plan.token).unwrap();
        assert_eq!(result.pending, 0);
        assert_eq!(identity(&source).unwrap(), stamp);
        assert_eq!(fs::read_to_string(source).unwrap(), "[[New|Old]]");
    }
    #[test]
    fn failed_receipt_persistence_leaves_the_original_source_bytes_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.md");
        fs::write(&path, "before").unwrap();
        let result = documents::save_with_receipt(&path, b"after", Some(b"before"), |_| {
            Err(io_failure("Injected journal failure".into()))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "before");
    }
    #[test]
    fn case_only_rename_keeps_the_id_and_updates_explicit_paths() {
        let dir = tempfile::tempdir().unwrap();
        let docs = Documents::default();
        docs.set_root(Some(Root::new(dir.path()).unwrap()));
        let old = dir.path().join("202611071530 old.md");
        fs::write(&old, "").unwrap();
        fs::write(
            dir.path().join("source.md"),
            "[Name](202611071530%20old.md)",
        )
        .unwrap();
        let cp = Checkpoint {
            tabs: vec![],
            active: 0,
            closed: false,
        };
        let mut plan = prepare(&docs, &old, "202611071530 Old.md", cp.clone(), None).unwrap();
        let candidates = plan
            .sources
            .iter()
            .map(|s| Candidates {
                key: s.key,
                spans: s
                    .text
                    .find("202611071530%20old.md")
                    .map(|from| {
                        vec![Span {
                            from,
                            to: from + "202611071530%20old.md".len(),
                            wiki: false,
                            reference: false,
                        }]
                    })
                    .unwrap_or_default(),
            })
            .collect();
        let preview = finalize(&mut plan, &docs, candidates).unwrap();
        assert!(preview.issues.is_empty(), "{:?}", preview.issues);
        let path = dir.path().join("private/rename.json");
        begin(
            &plan,
            &docs,
            cp,
            true,
            &path,
            &dir.path().join("private/session.json"),
        )
        .unwrap();
        let result = step(&docs, &path, &plan.token).unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(
            fs::read_to_string(dir.path().join("source.md"))
                .unwrap()
                .contains("202611071530%20Old.md")
        );
    }
}
