# Regressions
## Version 0.1.6 Regressions
### Mac Regressions
1. Live mode interface buttons bullets and numberd do not work. Code, link, table, and undo do.
2. Newline behavior is inconsistent across live and source mode.

### Linux Regressions
1. Live mode interface buttons bullets and numberd do not work. Code, link, table, and undo do.
2. Newline behavior is inconsistent across live and source mode.

## Investigation and follow-up

- List toolbar buttons skipped blank lines, preventing a new empty list item.
  The fix also places the caret after the marker, ready to type. Unit and app
  tests cover bullets, numbered lists and task lists in Live and Source modes.
- The reported preview example was plain `2`, `1`, `2` on consecutive lines.
  This is normal Markdown soft-break rendering, not lost document newlines;
  the user confirmed that the existing preview behavior should remain.
- Add View → Show line endings, off by default and remembered. Display LF,
  CRLF and CR symbols in the editor without changing document bytes or Preview.
- Remember View → Vim bindings across sessions, off by default until enabled.

## 0.1.7 follow-up: macOS smart dashes break table separators

- User identified typed `---` being replaced with typographic punctuation,
  preventing a Markdown table separator from parsing.
- Disable WebKit automatic dash substitution before creating a webview, using
  a process-local user-default override. Preserve other launch defaults,
  spelling support, existing document punctuation and system settings.
- The native check, Clippy and isolated Textgate Dashes Test app build pass.
  User confirmed the fix before authorizing the final review and commit.

## Validation on the earlier fix branch

- User-verified on M4: line-ending markers work correctly and are unobtrusive.
- 125 JavaScript tests and the frontend build pass.
- Isolated M4 test app: starting a blank bullet list and continuing it with
  Enter works; the native Show line endings menu displays LF markers in the
  editor while the preview renders the list normally.
- Native restart checks: Vim enabled persists as Vim NORMAL at startup;
  disabling it persists on the next restart. The enabled line-ending display
  also survives the restart.
- Unit coverage distinguishes LF/CRLF/CR, preserves mixed-ending/BOM bytes,
  updates markers after normalization and undo/redo, and verifies that toggling
  the display does not change the document, selection, format or undo history.
