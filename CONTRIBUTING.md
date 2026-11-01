# Developing Textgate

Textgate is an early desktop Markdown editor. See the [README](README.md) for
setup, supported syntax, and current fidelity limitations.

Use Node.js 24 and a current stable Rust toolchain with rustfmt and Clippy.
Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/),
then run `npm ci` and `npm run tauri dev`. Commit both dependency lockfiles when
changing dependencies.

## Checks

```sh
npm run check:version
npm test
npm run build
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

The Checks workflow runs these checks on Linux, macOS and Windows. The Release workflow runs
version consistency, JavaScript tests and Rust tests on each build runner before
packaging for Linux, Windows and both Mac architectures. The Intel Mac package is
cross-compiled on the macOS runner; its Rust tests execute on the runner's native
architecture. Neither workflow exercises native dialogs or interactive Vim
behavior. See [0.1.4 package testing](docs/testing-0.1.4.md) for manual checks.

Before tagging, update `Cargo.toml`, `tauri.conf.json`, `package.json`, both
lockfiles, and `docs/releases/<version>.md`. `npm run check:version` checks the six
version fields; the Release workflow also requires an exact matching `v` tag.
For a local tag check, set `RELEASE_TAG` to the proposed tag when running it.

For changes to editor behavior, open `examples/markdown-demo.md` in the desktop
app and check Live/Source switching, Vim editing, undo/redo, save/reopen, and
unsaved-change prompts. Include a regression test for content-preservation fixes.
For theme changes, check both built-in themes and the Default reset shortcut.

## Structure

- `web/main.js`: application events, editor synchronization, and native file calls.
- `web/menus.js`: native menus and keyboard-accessible browser fallback.
- `web/live-preview.js`: viewport-limited styling and state-backed layout replacements.
- `web/document-analysis.js`, `web/document-worker.js`: background word counts and outline parsing.
- `web/document-details.js`: cancel obsolete analyses and reconcile outline buttons.
- `scripts/benchmark-editor.mjs`: reproducible jsdom editor microbenchmark (`npm run benchmark`).
- `web/markdown-commands.js`: toolbar formatting commands on Markdown text.
- `web/document-store.js`: disk baselines and overwrite confirmation flow.
- `src/documents.rs`: scoped file access, conflict checks, and atomic saves.
- `src/launch.rs`: CLI parsing, native file grants, and the startup/open-request queue.
- `web/document-opener.js`, `web/external-open.js`: shared discard-safe opening and native request delivery.
- `tests/cli.rs`: actual binary help/version/error tests without a display.
- `web/document-format.js`: strict UTF-8 decoding, line endings, and BOM.
- `web/markdown.js`: preview rendering, sanitizing, and outline.
- `src/markdown.rs`: comrak preview rendering.
- `src/`: Rust application entry point and native theme storage.
- `themes/`: editable starter CSS themes.
- `docs/branding/`: approved logo concept and its provenance.

Keep Markdown files authoritative. An unedited supported UTF-8 file must round
trip byte for byte, including mixed line endings, BOM, trailing whitespace and
final-newline presence. Preserve source choices such as heading style, list
markers, comments and front matter. Rendering equivalence alone does not justify
rewriting source. Whole-document normalization must be an explicit, undoable user
action, and format-only changes must trigger unsaved-change protection. Describe
any serialization or undo behavior change explicitly. Prefer focused changes and tests over unrelated rewrites.

Textgate uses the [MIT License](LICENSE). Contributions are made under that license.
