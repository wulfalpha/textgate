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
        assert!(html.contains("<del>gone</del>"));
        assert!(html.contains(r#"<a href="https://example.com">"#));
        assert!(html.contains("footnote"));
        assert!(html.contains("markdown-alert"));
    }
}
