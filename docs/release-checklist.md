# Before the first public release

- [x] Choose the project license and add its text and package metadata (MIT).
- [x] Create the GitHub repository and initial commit after reviewing the file list.
- [x] Run the CI workflow on GitHub; local checks do not validate hosted execution.
- [x] Test native open/save, cancellation, and unsaved-change prompts on Linux (GTK dialogs, CRLF/BOM round trip).
- [x] Test Vim keystrokes by hand in the desktop app (macOS, Windows).
- [x] Validate the macOS build (Apple Silicon `.app` and `.dmg`).
- [x] Validate the Windows build (MSVC toolchain).
- [x] Replace the old T icon with production exports of the approved omega logo.
- [ ] Check native menus and icon appearance on each release platform.
- [x] Capture an app screenshot and add it to the README.
- [ ] Check CRLF and BOM files save byte-identical on Windows.

- [ ] Run the release workflow by hand (Actions → Release) and try the AppImage on a non-rolling distro.

Bundling is enabled (unsigned packages on every platform). Signing, crash recovery,
and automatic updates are not part of this prototype.

To release: set the version in `tauri.conf.json`, `Cargo.toml` and `package.json`,
push a matching tag such as `v0.2.0`, check the draft release's packages, then publish it.
