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

Bundling is enabled. Current-source Mac bundles use ad-hoc signatures; Windows
installers are unsigned. Developer ID signing/notarization, crash recovery, and
automatic updates are not configured.

To release: set the version in `tauri.conf.json`, `Cargo.toml` and `package.json`,
push a matching tag such as `v0.2.0`, check the draft release's packages, then publish it.

## Source changes after v0.1.1

Historical checked items above apply to earlier builds. Re-test the changed save
flow with a fresh build; the v0.1.1 downloads do not include it.

- [x] Implement atomic replacement and external-change confirmation.
- [x] Add visible feedback when close/file actions arrive during a busy operation.
- [x] Pass local JavaScript tests, frontend build, Rust tests, rustfmt, and Clippy.
- [x] Update the README and append current recommendations to improvements.md.
- [x] Confirm hosted Checks passed for save-integrity commit `fcae4a9`.
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


## v0.1.2 performance milestone

- [x] Confirm native Open and Live rendering in the user's local Linux build (screenshot of improvements.md).
- [x] Add the hybrid relative line numbers from priority 3 (View → Relative line numbers).
- [ ] Check relative line numbers with Vim counts (e.g. `5j`) in packaged apps on each platform.
- [x] Complete priority 2 and record reproducible before/after measurements in docs/performance.md.
- [x] Update root version fields to 0.1.2 and prepare docs/releases/0.1.2.md.
- [ ] Confirm hosted Checks passes for the v0.1.2 source commit.
- [ ] Confirm all v0.1.2 release jobs and package uploads succeed.
- [ ] Smoke-test scrolling, outline jumps, viewport-edge selections, tables, and Setext headings on each platform.
- [ ] Check large-document manual Refresh and background outline/count updates in packaged apps.
- [ ] Complete the native save-integrity checks above with the new build.

The v0.1.2 tag is a milestone for review. The rest of priority 3 and pending package tests
remain before the intended first official release; keep the GitHub release a draft.

## v0.1.3 first official release

- [x] Update root version fields to 0.1.3 and write docs/releases/0.1.3.md.
- [x] Confirm all v0.1.3 release jobs and package uploads succeed.
- [x] Publish the release with the 0.1.3 notes as its description (2026-10-28).
- [ ] Smoke-test the published downloads on Linux, macOS and Windows: open, save,
      zoom, F6, System theme, relative line numbers with Vim counts.


## macOS installation follow-up after v0.1.3

- [x] Record the M1/M4 report: downloaded app ran on M4; M1 runs after local
      re-signing plus quarantine removal. The original signature verified, so
      that combined repair does not isolate which step changed launch behavior.
- [x] Configure explicit ad-hoc signing (`bundle.macOS.signingIdentity = "-"`).
- [x] Add a strict bundle-signature verification step to both Mac release jobs.
- [x] Document targeted quarantine removal as the only interim Terminal install step.
- [x] Run the updated v0.1.4 release workflow and confirm both Mac signature checks pass.
- [ ] Download a fresh build on M1 and M4; copy to Applications and verify launch
      after only `xattr -dr com.apple.quarantine`, without manual re-signing.

Developer ID signing/notarization is deferred by choice. Do not change existing
release artifacts or claim the M1 installation issue resolved until tested.


## v0.1.4 CLI milestone (draft testing)

- [x] Add CLI path parsing, help/version, local file URLs, and `--` handling.
- [x] Queue startup and second-instance requests using the sender's working directory.
- [x] Reuse discard-safe opening and exact file grants for native requests.
- [x] Support missing files without creating them until Save; preserve conflict checks.
- [x] Add native macOS file-open handling and Markdown bundle associations.
- [x] Prepare cross-platform Checks jobs and CLI/open-flow regression tests.
- [x] Update root package versions, README, improvements, and release notes to prepare 0.1.4.
- [x] Pass local JavaScript tests, 19 Rust unit tests, two headless CLI integration tests, formatting, and Clippy.
- [x] Build the Linux DEB and inspect its Markdown MIME association and file argument forwarding.
- [x] Confirm hosted Checks succeeds on Linux, macOS, and Windows
      ([run 41262098457](https://github.com/wulfalpha/textgate/actions/runs/41262098457)).
- [x] Diagnose the first 0.1.4 Checks run: macOS/Linux passed; Windows compiled
      but failed the renderer fixture comparison after CRLF checkout conversion.
      Pin both renderer fixtures to LF; the fresh hosted Windows run now passes.
- [x] Check the packaged M4 binary: `--help`, `--version` (0.1.4), and exit-2
      diagnostics for unknown flags, multiple files, bare `--`, remote URLs and
      incomplete file URLs. All five launch-parser unit tests pass.
- [x] Inspect the packaged M4 Info.plist: `.md` and `.markdown` document types
      use Editor role and Alternate rank.
- [ ] Verify `textgate notes.md` both on first launch and while already running.
- [ ] Invoke from another working directory; test spaces, Unicode, `-- -name.md`, and file URLs.
- [x] On M4, user verified opening another Markdown file with unsaved edits:
      Keep editing cancels the open and retains edits; Discard opens the requested file.
- [ ] Repeat incoming-open protection with an active Save dialog and on Windows/Linux.
- [ ] Open a new filename, verify no disk file until Save, then test an external creation conflict.
- [ ] Test Finder Open With / `open -a`, Explorer Open With, and Linux installed desktop integration.
- [ ] Test `.md` and `.markdown` associations; reject multi-file requests clearly.
- [ ] Verify CLI help/version in Windows terminals and Mac/Linux shells.
- [ ] Complete fresh M1/M4 quarantine-only install checks and signature checks above.
- [ ] Build, inspect, and publish v0.1.4 only after release review.

## v0.1.4 stabilization (in progress)

- [x] Preserve mixed line endings by default, with undo/redo metadata.
- [x] Add explicit Edit → Normalize line endings for LF, CRLF and CR.
- [x] Include format-only changes in dirty tracking and saved snapshots.
- [x] Document the source-preservation policy and correct symbolic-link guidance.
- [ ] In packaged apps on Linux, macOS and Windows, open a BOM/mixed-ending file,
      save without editing and compare bytes; repeat after editing one word.
- [ ] Normalize to each offered style, save/reopen, and verify Undo/Redo and
      unsaved-change prompts, including normalization while a save is pending.
- [x] Add cross-platform Rust tests and tag/version consistency validation.
- [x] Set all version fields and lockfiles to 0.1.4; prepare the draft release notes.
- [x] Add a package testing guide and byte-exact fixture generator.
- [x] Pass local M4 checks: 80 JavaScript and 21 Rust/CLI tests, formatting and Clippy.
- [x] Verify the merged Mac app's ad-hoc signature, mixed/BOM byte round trip,
      explicit CRLF normalization, undo/redo and format-only dirty tracking.
- [x] Complete final DMG creation/checksum verification and push `v0.1.4` at `3adaec8`.
- [x] Confirm all four release jobs pass, both Mac signatures verify, and all nine
      package assets plus the test-fixture ZIP are attached to the draft
      ([run 41262517205](https://github.com/wulfalpha/textgate/actions/runs/41262517205)).
- [x] Record user-verified Windows 11 MSI and Arch Linux AppImage testing:
      fonts stable and Normalize line endings present in the Edit menu.
- [ ] Review the remaining detailed save/normalization, CLI and Mac installation
      checks before deciding to publish the release.
