# Before the first public release

- [x] Choose the project license and add its text and package metadata (MIT).
- [x] Create the GitHub repository and initial commit after reviewing the file list.
- [x] Run the CI workflow on GitHub; local checks do not validate hosted execution.
- [x] Test native open/save, cancellation, and unsaved-change prompts on Linux (GTK dialogs, CRLF/BOM round trip).
- [ ] Test Vim keystrokes by hand in the desktop app.
- [ ] Validate macOS and Windows builds before claiming tested support.
- [x] Replace the old T icon with production exports of the approved omega logo.
- [ ] Check native menus and icon appearance on each release platform.
- [x] Capture an app screenshot and add it to the README.
- [ ] Check CRLF and BOM files save byte-identical on Windows.

Installer bundling is currently disabled. Signing, installers, crash recovery,
and automatic updates are not part of this prototype.
