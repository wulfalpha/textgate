# Release checklist

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

- [x] Run the v0.1.1 tag release workflow successfully on Linux, Windows, Apple Silicon, and Intel Mac (`feffc6a`).
- [x] Inspect the v0.1.1 draft and verify all nine expected package assets are attached.
- [ ] Smoke-test the downloaded v0.1.1 AppImage (user testing pending; local executable success is separate).
- [ ] Try the AppImage on a non-rolling distribution.
- [ ] Expand the release notes with changes and platform download guidance before publishing.

Bundling is enabled (unsigned packages on every platform). Signing, crash recovery,
and automatic updates are not part of this prototype.

To release: set the version in `tauri.conf.json`, `Cargo.toml` and `package.json`,
push a matching tag such as `v0.2.0`, check the draft release's packages, then publish it.

## Source changes after v0.1.1

Historical checked items above apply to earlier builds. Re-test the changed save
flow with a fresh build; the v0.1.1 downloads do not include it.

- [x] Implement atomic replacement and external-change confirmation.
- [x] Add visible feedback when close/file actions arrive during a busy operation.
- [x] Pass local JavaScript tests, frontend build, Rust tests, rustfmt, and Clippy.
- [x] Update the README and append current recommendations to improvements.md.
- [ ] Confirm hosted Checks passes for the commit containing these changes.
- [ ] Run Rust file-operation tests on Windows and macOS.


- [ ] On Linux, macOS, and Windows, open and save a UTF-8 BOM/CRLF file and compare bytes.
- [ ] Modify the open file in another editor; verify Cancel preserves both versions and Overwrite saves the buffer.
- [ ] Delete the open file externally; verify recreation requires confirmation.
- [ ] Test Save As to a new file and an existing file, plus cancelled dialogs.
- [ ] Verify write errors leave the buffer dirty and show a useful message.
- [ ] Verify unselected paths cannot be read or saved through the new commands.
- [ ] During a native dialog or write, request close: verify feedback, no delayed close, and unsaved-change checks on retry.

Automated Rust tests cover replacement, same-size external edits, deletions,
partial-write failure, temporary-file cleanup, and Unix permissions/link handling.
JavaScript tests cover exact disk baselines and confirmation/retry behavior.
