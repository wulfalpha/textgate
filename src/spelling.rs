//! WebKitGTK ships with its spell checker turned off for every web view, so the
//! editor's `spellcheck` attribute does nothing on Linux until the web context
//! enables it with a list of dictionaries. macOS and Windows web views check
//! spelling as soon as the page asks.

/// Spell-checking languages from the usual locale variables, as WebKitGTK's
/// Enchant backend names them (`en_US`, `de`). Falls back to US English.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn languages(var: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    // LANGUAGE is a colon-separated preference list; the others hold one locale.
    let lists = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| var(name).filter(|value| !value.is_empty()));
    for list in lists {
        for locale in list.split(':') {
            // en_US.UTF-8@euro -> en_US
            let name = locale.split(['.', '@']).next().unwrap_or_default();
            if name.is_empty() || name == "C" || name == "POSIX" {
                continue;
            }
            if !found.iter().any(|known| known == name) {
                found.push(name.to_owned());
            }
        }
    }
    if found.is_empty() {
        found.push("en_US".to_owned());
    }
    found
}

#[cfg(target_os = "linux")]
pub fn enable(webview: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webkit2gtk::{WebContextExt, WebViewExt};
    let languages = languages(|name| std::env::var(name).ok());
    webview.with_webview(move |platform| {
        if let Some(context) = platform.inner().context() {
            let names: Vec<&str> = languages.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&names);
            context.set_spell_checking_enabled(true);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::languages;

    fn from(pairs: &'static [(&'static str, &'static str)]) -> Vec<String> {
        languages(|name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn strips_encodings_and_modifiers() {
        assert_eq!(from(&[("LANG", "en_GB.UTF-8")]), ["en_GB"]);
        assert_eq!(from(&[("LANG", "de_DE@euro")]), ["de_DE"]);
    }

    #[test]
    fn prefers_language_list_and_removes_duplicates() {
        assert_eq!(
            from(&[("LANGUAGE", "fr_CA:fr:en_US"), ("LANG", "en_US.UTF-8")]),
            ["fr_CA", "fr", "en_US"]
        );
    }

    #[test]
    fn falls_back_to_english_for_c_and_empty_locales() {
        assert_eq!(from(&[("LANG", "C.UTF-8"), ("LC_ALL", "")]), ["en_US"]);
        assert_eq!(from(&[("LANG", "POSIX")]), ["en_US"]);
        assert_eq!(from(&[]), ["en_US"]);
    }
}
