use serde::Serialize;
use std::{fs, io::Write, path::Path};
use tauri::Manager;

#[derive(Serialize)]
pub struct ThemeState {
    directory: String,
    themes: Vec<String>,
    selected: String,
    css: String,
    warning: Option<String>,
}

fn seed(path: &Path, css: &str) -> Result<(), String> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file.write_all(css.as_bytes()).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Follows the operating system: the built-in light styles, plus dark.css
// whenever the system prefers dark. Theme files all end in .css, so this name
// cannot collide with one.
pub const SYSTEM: &str = "system";

fn read_theme(directory: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Ok(String::new());
    }
    if name == SYSTEM {
        let dark = read_theme(directory, "dark.css")?;
        return Ok(format!(
            "@media (prefers-color-scheme: dark) {{\n{dark}\n}}\n"
        ));
    }
    if name.contains(['/', '\\']) || !name.ends_with(".css") || name == ".css" {
        return Err("Choose a CSS filename in the themes directory.".into());
    }
    let path = directory.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err("Themes must be regular CSS files smaller than 1 MiB.".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

fn load(root: &Path, selection: Option<String>) -> Result<ThemeState, String> {
    let directory = root.join("themes");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    seed(
        &directory.join("light.css"),
        include_str!("../themes/light.css"),
    )?;
    seed(
        &directory.join("dark.css"),
        include_str!("../themes/dark.css"),
    )?;
    let mut themes = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file()
            && let Some(name) = entry.file_name().to_str()
            && name.ends_with(".css")
            && name != ".css"
        {
            themes.push(name.to_owned());
        }
    }
    themes.sort();
    let preference = root.join("theme.txt");
    let requested = match selection.as_ref() {
        Some(name) => name.clone(),
        None => match fs::read_to_string(&preference) {
            Ok(name) => name.trim_end_matches(['\r', '\n']).to_owned(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        },
    };
    let (selected, css, warning) = match read_theme(&directory, &requested) {
        Ok(css) => (requested, css, None),
        Err(e) if selection.is_none() => (
            String::new(),
            String::new(),
            Some(format!("Could not load saved theme: {e}. Using Default.")),
        ),
        Err(e) => return Err(e),
    };
    if selection.is_some() {
        fs::write(preference, &selected).map_err(|e| e.to_string())?;
    }
    Ok(ThemeState {
        directory: directory.to_string_lossy().into_owned(),
        themes,
        selected,
        css,
        warning,
    })
}

#[tauri::command]
pub fn theme_state(app: tauri::AppHandle, selection: Option<String>) -> Result<ThemeState, String> {
    let root = app
        .path()
        .config_dir()
        .map_err(|e| e.to_string())?
        .join("textgate");
    load(&root, selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "textgate-themes-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn seeds_without_overwriting_and_persists_and_reloads() {
        let root = TestDir::new();
        let state = load(&root.0, None).unwrap();
        assert_eq!(state.themes, ["dark.css", "light.css"]);
        assert_eq!(state.selected, "");
        let file = root.0.join("themes/dark.css");
        fs::write(&file, ":root { --tg-text: pink; }").unwrap();
        assert!(
            load(&root.0, Some("dark.css".into()))
                .unwrap()
                .css
                .contains("pink")
        );
        assert_eq!(load(&root.0, None).unwrap().selected, "dark.css");
        fs::write(&file, ":root { --tg-text: red; }").unwrap();
        assert!(load(&root.0, None).unwrap().css.contains("red"));
        load(&root.0, Some(String::new())).unwrap();
        assert!(load(&root.0, None).unwrap().css.is_empty());
    }

    #[test]
    fn system_theme_applies_dark_css_only_when_the_system_is_dark() {
        let root = TestDir::new();
        load(&root.0, None).unwrap();
        fs::write(
            root.0.join("themes/dark.css"),
            ":root { --tg-text: white; }",
        )
        .unwrap();
        let state = load(&root.0, Some(SYSTEM.into())).unwrap();
        assert_eq!(state.selected, SYSTEM);
        assert!(
            state
                .css
                .starts_with("@media (prefers-color-scheme: dark) {")
        );
        assert!(state.css.contains("--tg-text: white"));
        assert_eq!(load(&root.0, None).unwrap().selected, SYSTEM);
        // A deleted dark.css is seeded again, so System keeps working.
        fs::remove_file(root.0.join("themes/dark.css")).unwrap();
        let state = load(&root.0, None).unwrap();
        assert!(state.warning.is_none());
        assert!(state.css.contains("color-scheme: dark"));
    }

    #[test]
    fn rejects_paths_and_recovers_from_missing_saved_theme() {
        let root = TestDir::new();
        load(&root.0, None).unwrap();
        for name in [
            "../secret.css",
            "/tmp/secret.css",
            "..\\secret.css",
            "theme.txt",
        ] {
            assert!(load(&root.0, Some(name.into())).is_err());
        }
        fs::write(root.0.join("themes/custom.css"), "body { color: red; }").unwrap();
        load(&root.0, Some("custom.css".into())).unwrap();
        fs::remove_file(root.0.join("themes/custom.css")).unwrap();
        let state = load(&root.0, None).unwrap();
        assert!(state.warning.is_some());
        assert!(state.css.is_empty());
    }
}
