//! Notifications are hints, never permission grants or new save baselines.
//! Exact byte comparisons remain authoritative, with focus/periodic fallbacks.
use crate::documents::{DiskChange, Documents};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct Watching(Mutex<State>);
#[derive(Default)]
struct State {
    watcher: Option<RecommendedWatcher>,
    paths: HashMap<PathBuf, RecursiveMode>,
    changed: Arc<AtomicBool>,
    checked: Option<Instant>,
}
#[derive(Serialize)]
pub struct Changes {
    pub scan: bool,
    pub documents: Vec<DiskChange>,
    pub warning: Option<String>,
}

impl State {
    fn poll(&mut self, documents: &Documents, force: bool, folders: &[PathBuf]) -> Changes {
        let mut wanted: HashMap<_, _> = documents
            .watch_parents()
            .into_iter()
            .map(|path| (path, RecursiveMode::NonRecursive))
            .collect();
        if let Some(root) = documents.root() {
            let path = root.watch_path().to_path_buf();
            if let Some(parent) = path.parent() {
                wanted
                    .entry(parent.to_path_buf())
                    .or_insert(RecursiveMode::NonRecursive);
            }
            wanted.insert(path, RecursiveMode::NonRecursive);
            // Only the root and expanded folders need live listings. Never
            // traverse a whole workspace or follow a link outside its scope.
            for folder in folders.iter().take(512) {
                if root.contains(folder)
                    && let Ok(real) = std::fs::canonicalize(folder)
                {
                    wanted.insert(real, RecursiveMode::NonRecursive);
                }
            }
        }
        let mut warnings = Vec::new();
        if self.watcher.is_none() && !wanted.is_empty() {
            let changed = self.changed.clone();
            match RecommendedWatcher::new(
                move |event: notify::Result<Event>| {
                    // Reads made by our own comparison must not trigger more scans.
                    if !matches!(
                        event,
                        Ok(Event {
                            kind: EventKind::Access(_),
                            ..
                        })
                    ) {
                        changed.store(true, Ordering::Relaxed);
                    }
                },
                Config::default().with_follow_symlinks(false),
            ) {
                Ok(watcher) => self.watcher = Some(watcher),
                Err(error) => warnings.push(error.to_string()),
            }
        }
        let changed_paths = wanted != self.paths;
        if let Some(watcher) = &mut self.watcher {
            self.paths.retain(|path, mode| {
                if wanted.get(path) == Some(mode) {
                    true
                } else {
                    let _ = watcher.unwatch(path);
                    false
                }
            });
            for (path, mode) in wanted {
                if self.paths.get(&path) == Some(&mode) {
                    continue;
                }
                match watcher.watch(&path, mode) {
                    Ok(()) => {
                        self.paths.insert(path, mode);
                    }
                    Err(error) => warnings.push(error.to_string()),
                }
            }
        }
        let notification = self.changed.swap(false, Ordering::Relaxed);
        let scan = force
            || changed_paths
            || notification
            || self
                .checked
                .is_none_or(|time| time.elapsed() >= Duration::from_secs(30));
        let changes = if scan {
            self.checked = Some(Instant::now());
            documents.disk_changes()
        } else {
            Vec::new()
        };
        Changes { scan, documents: changes, warning: (!warnings.is_empty()).then(||
            format!("Live file notifications unavailable for some locations; focus and periodic checks remain active. {}", warnings.join("; "))) }
    }
}

#[tauri::command]
pub async fn poll_disk_changes(
    app: tauri::AppHandle,
    force: bool,
    folders: Vec<PathBuf>,
) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Watching>()
            .0
            .lock()
            .unwrap()
            .poll(&app.state::<Documents>(), force, &folders)
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Root;
    use std::{fs, thread};

    #[test]
    fn watches_only_native_open_parents_and_permitted_expanded_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let inside = root.join("notes");
        let outside = dir.path().join("ungranted");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir(&outside).unwrap();
        let documents = Documents::default();
        documents.set_root(Some(Root::new(&root).unwrap()));
        let mut state = State::default();
        let result = state.poll(&documents, true, &[inside.clone(), outside.clone()]);
        assert!(result.scan);
        assert!(result.warning.is_none(), "{:?}", result.warning);
        assert!(
            state
                .paths
                .contains_key(&fs::canonicalize(&inside).unwrap())
        );
        assert!(!state.paths.contains_key(&outside));
        assert!(
            state
                .paths
                .values()
                .all(|mode| *mode == RecursiveMode::NonRecursive)
        );
        documents.set_root(None);
        state.poll(&documents, false, &[]);
        assert!(state.paths.is_empty());
    }

    #[test]
    fn parent_notifications_detect_atomic_replacement_and_force_checks_remain_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        fs::write(&path, "original").unwrap();
        let documents = Documents::default();
        documents
            .restore_recovery(Some((path.clone(), None)), "", false)
            .unwrap();
        let mut state = State::default();
        assert!(state.poll(&documents, true, &[]).warning.is_none());
        let staged = dir.path().join("replacement.tmp");
        fs::write(&staged, "replacement").unwrap();
        fs::rename(&staged, &path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if state.poll(&documents, false, &[]).scan {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no parent notification after replacement"
            );
            thread::sleep(Duration::from_millis(50));
        }
        assert!(state.poll(&documents, true, &[]).scan);
        state.checked = Some(Instant::now() - Duration::from_secs(31));
        assert!(state.poll(&documents, false, &[]).scan);
    }
}
