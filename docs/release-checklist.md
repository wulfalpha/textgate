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
- [x] On M4, download fresh 0.1.4, copy to Applications, and launch using
      Privacy & Security → Open Anyway, without Terminal commands or re-signing.
      Installed app files match the downloaded DMG byte for byte and the strict
      bundle-signature check passes.
- [ ] Verify a fresh M1 installation; quarantine-removal-only launch remains a
      separate untested installation alternative.

Developer ID signing/notarization is deferred by choice. Do not change existing
release artifacts or claim the M1 installation issue resolved until tested.


## v0.1.4 CLI milestone

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
- [x] On M4, user verified CLI first launch opens `first-launch.md` in one
      window, and subsequent invocations switch the existing window.
- [x] On M4, user verified a relative path from `/tmp/textgate-cli-checks`,
      spaces/Unicode (`spaces and café.md`), `-- -dash.md`, and a local file URL.
- [ ] Repeat CLI first-launch, forwarding and path-variant checks on Windows/Linux.
- [x] On M4, user verified opening another Markdown file with unsaved edits:
      Keep editing cancels the open and retains edits; Discard opens the requested file.
- [x] On M4, user verified an incoming open during Save As prompts once for
      unsaved changes afterward; the prompt does not repeat.
- [ ] Repeat incoming-open protection on Windows/Linux.
- [x] On M4, open `/tmp/textgate-missing-test.md` via the installed app's CLI:
      empty named document, ABSENT before Save, EXISTS after Save (screenshots).
- [x] On M4, user verified an external editor's saved changes trigger the
      changed-on-disk dialog when saving the Textgate buffer.
- [x] On M4, user approved Overwrite after an external edit and verified the
      disk contents matched Textgate (including “Yes” changed to “no”).
- [x] On M4, moving the open test file to Trash triggered Cancel/Recreate.
      Cancel retained the buffer without restoring the original path; Recreate
      created a new file at that path and left the trashed original intact.
- [x] On M4, Save As to a new filename produced a copy matching the buffer.
- [x] On M4, user verified Zed creating the same prepared-but-unsaved filename
      triggers an overwrite confirmation in Textgate before replacement.
- [x] On M4, user verified Save As replaces an existing file with an overwrite
      warning, and cancelling the Save As dialog behaves as expected.
- [ ] Repeat the detailed save-integrity checks on Windows/Linux.
- [ ] Test Finder Open With / `open -a`, Explorer Open With, and Linux installed desktop integration.
- [ ] Test `.md` and `.markdown` associations; reject multi-file requests clearly.
- [ ] Verify CLI help/version in Windows terminals and Mac/Linux shells.
- [ ] Complete fresh M1/M4 quarantine-only install checks and signature checks above.
- [x] Build and inspect v0.1.4; complete M4 installation and release review.
- [x] Publish [v0.1.4](https://github.com/wulfalpha/textgate/releases/tag/v0.1.4)
      as the latest release with all nine package assets and the test-fixture ZIP.

## v0.1.4 stabilization (released; follow-up tests tracked below)

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
- [x] Review completed checks and publish after the verified M4 installation.
      Keep the remaining platform-specific checks above as follow-up coverage.


## v0.1.5 spell check update

- [x] Vim: keep the block cursor full height while an operator, count or register
      is pending and in Replace mode; show `Vim REPLACE` in the status bar.
- [x] Vim: `:w`, `:saveas`, `:wq`/`:x`, `:q`/`:qa` and `!` forms through the app's
      save/close paths. `:q` with unsaved changes refuses with E37, as in Vim.
- [x] Spellcheck: View → Check spelling (on by default, remembered). Code, URLs,
      raw HTML and front matter are excluded. Linux enables WebKitGTK's checker
      with dictionaries from LANGUAGE/LC_ALL/LC_MESSAGES/LANG (fallback en_US).
      macOS registers WebKit's `WebContinuousSpellCheckingEnabled` default.
      The editor takes focus at launch, since checking starts on focus.
- [x] User verified spelling underlines on macOS (M4, dev build) and Linux (Arch,
      source build, after the editor gained focus).
- [x] Bundle iA Writer Quattro S (document) and iA Writer Mono S (code, Source
      mode, Vim prompt) as unmodified OFL webfonts; credit them in the README.
      The interface keeps the system font.
- [x] Restyle Vim's `:` prompt; outline the unfocused block cursor in the accent;
      widen the block at line ends.
- [x] Confirm hosted Checks compile the Linux-only WebKitGTK spelling code (run 41579359304).
- [x] Confirm hosted Checks compile the macOS spelling default (run 41581394953).
- [x] Windows (dev build, Windows 11): View → Check spelling is present but no
      words are underlined. Cause not identified; documented in the README as a
      known issue for 0.1.5. Diagnostics to try later: whether a plain
      `<textarea spellcheck>` is underlined in the same WebView2, the
      `.cm-content` spellcheck property, and Settings → Time & language → Typing.
- [ ] On Linux (with hunspell dictionaries installed) and macOS: misspelled
      prose is underlined in Live and Source modes; code and URLs are not;
      right-click offers suggestions; the toggle removes underlines.
- [ ] Check the Vim cursor after `d`, `c`, `5`, `"a` and `R` on each platform.
- [ ] Check the bundled fonts in Live, Source, preview and tables on each platform
      (bold/italic, headings, code blocks, relative-number gutter alignment).
- [ ] Check `:w`, `:wq`, `:q` (dirty and clean), `:q!` and `:sav` in packaged apps.
- [x] Update all version fields and lockfiles to 0.1.5 (`npm run check:version`)
      and write docs/releases/0.1.5.md.
- [x] Merge to main, tag `v0.1.5`, and confirm all release jobs and assets
      (run 41583662348; nine assets on the draft).
- [x] AppImage on Arch (hunspell-en_us installed): no underlines. Its libenchant
      is Ubuntu's, which loads providers only from the fixed, non-relocatable
      `/usr/lib/x86_64-linux-gnu/enchant-2` and ships none; probed: 0 dictionaries
      bundled vs en_US via the system library. Using the host libenchant instead
      fails to load (needs GLib 2.76's `g_free_sized`, bundled GLib is 2.72,
      BIND_NOW). Shipped as a known issue; 0.1.6: build enchant 2.3.2 with
      `--enable-relocatable` plus the hunspell provider and libhunspell on the
      22.04 runner and swap them into the AppImage.
- [ ] Smoke-test the packaged apps (AppImage spelling dictionaries especially)
      before publishing; update the README status and download names.

## v0.1.6

- [x] AppImage spelling: `packaging/appimage/build-enchant.sh` builds enchant
      2.3.2 (checksum-pinned) with `--enable-relocatable` and the Hunspell
      provider on the 22.04 runner; `tauri.appimage.json` bundles it with
      libhunspell, and the release job's `check-spelling.py` step fails unless
      the bundled provider loads and finds en_US.
- [x] Prototype (script built in an ubuntu:22.04 container, swapped into the
      0.1.5 AppImage): check passes on Arch with system and bundled GLib, and the
      user saw misspellings underlined.
- [x] Confirm a hosted Release run builds the AppImage with the relocatable
      library and passes the spelling check (run 41753208124: provider loaded
      from the AppImage's own `usr/lib/enchant-2`).
- [x] That run's AppImage on Arch: misspellings underlined (user-verified).
- [ ] Downloaded AppImage on one RPM distribution (Fedora) and Debian/Ubuntu;
      then drop the README known issue.
- [x] Tabs (plan: docs/plans/0.1.6-tabs.md): per-document Rust baselines and
      file identity, tab bar and switching, Save / Don't Save / Cancel on close,
      Vim tab commands, several files from the command line and file manager.
- [x] Linux (dev build): opening several files at once and one at a time,
      same-named files, saving each tab, all three close-dialog buttons, three
      files at launch, forwarding files to a running window (a new file and a
      linked-folder path to an open file), `:w` creating the new file.
- [x] Windows MSI feature testing recorded below, using the initial 0.1.6
      package (run 41879520058) and the shortcut-fix rebuild (run 41958938880,
      commit d0af70c). README and release-note platform status reflect the
      completed checks; the standalone native Close Tab menu check remains below.
- [x] Windows MSI 0.1.6: tab switching works (user-verified).
- [ ] Windows: standalone native File → Close Tab item. Close-dialog buttons
      and Ctrl+W passed.
- [x] Windows MSI 0.1.6: quit-dialog Quit Without Saving and Cancel both work
      (user-verified).
- [x] macOS (M4, locally packaged app installed in Applications): Finder
      multi-select → Open With Textgate opened every file in its own tab, both at
      launch and into the running window; files open from the file browser.
- [x] Windows MSI 0.1.6: CLI opens a new file, switches to an already-open
      file's tab, and opens multiple files (user-verified).
- [x] Windows MSI 0.1.6: after manually adding Textgate as an Open With option,
      Explorer opens each selected file in its own tab, including into an
      already-running Textgate (user-verified). Automatic Open With discovery
      remains unverified.
- [x] Packaged Linux: file-manager multi-select → Open With (desktop entry `%U`)
      opened every file (user-verified).
- [x] File browser (plan: docs/plans/0.1.6-file-browser.md): workspace roots,
      the Files sidebar, creating, rename and trash, folder argument, sidebar
      width and remembered folders.
- [x] Linux (dev build): browsing, opening and saving deep and linked files,
      refresh on focus, remembered workspace, New File/Folder from the menu and
      buttons, refused names, renaming open files and folders, trash (with the
      tab kept), Show in File Manager, keyboard.
- [x] Linux: `textgate <folder>` at launch and forwarded to a running window;
      sidebar resizing; folders reopening.
- [x] Renames use the platform's exclusive rename (macOS `renamex_np`
      RENAME_EXCL, Linux `renameat2` RENAME_NOREPLACE, Windows `MoveFileExW`
      without replace), so an entry created after the name check is never
      replaced; case-only renames of the same entry still work.
- [x] macOS (M4, dev build): trash without a Finder permission prompt, Show in
      Finder and a case-only rename passed; tabs (switching keys, Cmd+W, Close Tab,
      Save / Don't Save / Cancel, quit prompt) passed.
- [x] macOS: Cmd+Backspace failed after clicking a file (the click moved focus to
      the editor). Clicks now keep focus in the list; Enter moves into the file.
      Retested on M4: Cmd+Backspace trashes the clicked file, its tab keeps the
      text so it can be recovered, and quitting asks before discarding it.
- [x] Windows MSI 0.1.6: Show in File Manager and Move to Trash work;
      creating text.md, renaming to glory.md and Text.md, and creating test.txt
      work (user-verified).
- [x] Windows MSI 0.1.6: changing only a letter's capitalization in a rename
      works; trashing an open file keeps its text; creating a file named
      test1.1 works (user-verified).
- [x] Windows MSI 0.1.6: an open tab follows a file-browser rename
      (user-verified).
- [x] Windows MSI 0.1.6: user confirmed installation with elevation, launch,
      version 0.1.6, Files panel and tabs visible. Menu Save works; spelling
      remains the known Windows issue.
- [x] Windows MSI 0.1.6: Save / Don't Save / Cancel on the tab-close dialog
      all work (user-verified).
- [x] Windows MSI 0.1.6 rebuild (run 41958938880, commit d0af70c): Ctrl+S,
      Ctrl+Shift+S and Ctrl+W all work with the proper prompts (user-verified).
      The fix keeps the page shortcut handler active on Windows even with
      native menus installed.
