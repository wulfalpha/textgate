use comrak::{Options, markdown_to_html};

// GitHub-flavored rendering via comrak, a port of GitHub's cmark-gfm.
// Raw HTML is passed through here and sanitized by DOMPurify in the webview.
fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.alerts = true;
    options.extension.header_id_prefix = Some(String::new());
    options.extension.front_matter_delimiter = Some("---".into());
    options.render.r#unsafe = true;
    options.render.github_pre_lang = true;
    options.render.tasklist_classes = true;
    options
}

pub fn render(source: &str) -> String {
    markdown_to_html(source, &options())
}

#[tauri::command]
pub async fn render_markdown(source: String) -> String {
    render(&source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_github_flavored_extensions() {
        let html = render(
            "---\ntitle: Hidden\n---\n\n# Title\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~ https://example.com\n\nNote[^1].\n\n[^1]: Footnote.\n\n> [!NOTE]\n> Alert\n",
        );
        assert!(!html.contains("Hidden"));
        assert!(html.contains(r##"id="title""##));
        assert!(html.contains(r#"<td align="right">2</td>"#));
        assert!(html.contains(r#"type="checkbox""#));
        assert!(html.contains("contains-task-list"));
        assert!(html.contains("<del>gone</del>"));
        assert!(html.contains(r#"<a href="https://example.com">"#));
        assert!(html.contains("footnote"));
        assert!(html.contains("markdown-alert"));
    }

    #[test]
    fn matches_the_sanitizer_fixture() {
        // web/markdown.test.js sanitizes this exact output. When comrak's output
        // changes, review it and regenerate with TEXTGATE_UPDATE_FIXTURES=1.
        let html = render(include_str!("../web/fixtures/comrak-sample.md"));
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/web/fixtures/comrak-sample.html"
        );
        if std::env::var_os("TEXTGATE_UPDATE_FIXTURES").is_some() {
            std::fs::write(path, &html).unwrap();
        }
        assert_eq!(html, std::fs::read_to_string(path).unwrap());
    }
}
