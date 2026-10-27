# Developing Textgate

Textgate is an early desktop Markdown editor. See the [README](README.md) for
setup, supported syntax, and current fidelity limitations.

Use Node.js 24 and a current stable Rust toolchain with rustfmt and Clippy.
Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/),
then run `npm ci` and `npm run tauri dev`. Commit both dependency lockfiles when
changing dependencies.

## Checks

```sh
npm test
npm run build
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The GitHub Actions workflow runs these checks on Linux. It does not exercise
native dialogs, interactive Vim behavior, or macOS/Windows packaging.

For changes to editor behavior, open `examples/markdown-demo.md` in the desktop
app and check Live/Source switching, Vim editing, undo/redo, save/reopen, and
unsaved-change prompts. Include a regression test for content-preservation fixes.
For theme changes, check both built-in themes and the Default reset shortcut.

## Structure

- `web/main.js`: application events, editor synchronization, and native file calls.
- `web/menus.js`: native menus and keyboard-accessible browser fallback.
- `web/live-preview.js`: Live mode decorations (styling and hidden markup).
- `web/markdown-commands.js`: toolbar formatting commands on Markdown text.
- `web/document-format.js`: strict UTF-8 decoding, line endings, and BOM.
- `web/markdown.js`: preview rendering, sanitizing, and outline.
- `src/markdown.rs`: comrak preview rendering.
- `src/`: Rust application entry point and native theme storage.
- `themes/`: editable starter CSS themes.
- `docs/branding/`: approved logo concept and its provenance.

Keep Markdown files authoritative. Describe any serialization or undo behavior
change explicitly. Prefer focused changes and tests over unrelated rewrites.

Textgate uses the [MIT License](LICENSE). Contributions are made under that license.
