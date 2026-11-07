use comrak::{Anchorizer, Arena, Options, markdown_to_html, nodes::NodeValue, parse_document};

// GitHub-flavored rendering via comrak, a port of GitHub's cmark-gfm.
// Raw HTML is passed through here and sanitized by DOMPurify in the webview.
pub(crate) fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.wikilinks_ignore_embeds = true;
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

fn heading_line(source: &str, fragment: &str) -> Option<usize> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options());
    let mut anchors = Anchorizer::new();
    for node in root.descendants() {
        if matches!(node.data.borrow().value, NodeValue::Heading(_))
            && anchors.anchorize(&node.collect_text()) == fragment
        {
            return Some(node.data.borrow().sourcepos.start.line);
        }
    }
    None
}

#[tauri::command]
pub async fn note_heading_line(source: String, fragment: String) -> Result<Option<usize>, String> {
    tauri::async_runtime::spawn_blocking(move || heading_line(&source, &fragment))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_destinations_with_spaces_render_with_standard_markdown_syntax() {
        for source in [
            "![Screenshot](<images/My screenshot.png>)",
            "![Screenshot](images/My%20screenshot.png)",
        ] {
            let html = render(source);
            assert!(html.contains("<img "), "{html}");
            assert!(html.contains("images/My%20screenshot.png"), "{html}");
        }
    }

    #[test]
    fn heading_links_match_rendered_ids_including_duplicates_and_nested_headings() {
        let source = "# Café *notes*\n\n# Café notes\n\n> ## Nested `code`\n";
        assert_eq!(heading_line(source, "café-notes"), Some(1));
        assert_eq!(heading_line(source, "café-notes-1"), Some(3));
        assert_eq!(heading_line(source, "nested-code"), Some(5));
        assert_eq!(heading_line(source, "missing"), None);
    }

    #[test]
    fn renders_wiki_aliases_without_turning_code_or_embeds_into_links() {
        let html = render("[[Note name|Label]] `[[Code]]` ![[Embed]] \\[[Escaped]]");
        assert!(html.contains("data-wikilink=\"true\">Label</a>"));
        assert!(html.contains("<code>[[Code]]</code>"));
        assert!(!html.contains("href=\"Embed\""));
        assert!(!html.contains("href=\"Escaped\""));
    }

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
