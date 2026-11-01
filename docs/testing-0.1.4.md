# Testing Textgate 0.1.4

Download the 0.1.4 packages and `Textgate_0.1.4_save-fixtures.zip` from
[GitHub Releases](https://github.com/wulfalpha/textgate/releases). The ZIP includes ready-to-use fixtures,
hashes, a standalone verifier and `START-HERE.txt`.

Run against the packaged 0.1.4 app. Record the OS, processor architecture,
package filename and result. Building or passing automated tests does not count
as completing the native checks below.

## Source preservation

With Node.js installed, create a fresh fixture directory from this checkout:

```sh
node scripts/save-fixtures.mjs ./target/save-fixtures-0.1.4
```

The generator refuses to overwrite existing files. It writes mixed/BOM, CRLF/BOM,
LF/no-final-newline and CR files, plus SHA-256 hashes. Generating bytes directly
avoids Git checkout settings changing the test inputs.

1. Open each `.md` fixture through File → Open. Switch Live/Source, then Save.
2. Verify every byte is unchanged:

   ```sh
   node scripts/save-fixtures.mjs --verify ./target/save-fixtures-0.1.4
   ```

3. Edit one word, save/reopen and confirm only that word changes. Undo before
   saving and confirm byte preservation again. Keep the original fixtures for
   comparison; use a copy for the following tests.
4. Choose Edit → Normalize line endings…. Cancel first: the document must remain
   unchanged. Apply each of LF, CRLF and CR in turn. The dirty marker must appear,
   while text and rendering stay the same. Undo clears the marker; Redo restores
   it. Save/reopen and check the requested line-ending style and preserved BOM.
5. Normalize without saving, then request New, Open or Close. Each must protect
   the unsaved normalization with the usual discard prompt.
6. While a save/dialog is pending, continue editing or normalize where available.
   After the save completes, later edits must still be marked unsaved.

On Windows, `Get-FileHash -Algorithm SHA256 <file>` can also be compared with
`SHA256SUMS`. On macOS use `shasum -a 256 <file>`; on Linux use `sha256sum <file>`.

## Native regression checks

- Launch the packaged binary with `--help` and `--version` (must report 0.1.4).
  Open a Markdown path on first launch and through a second invocation. Check
  spaces, Unicode, a different working directory, `-- -name.md`, and file URLs.
- Send a file-open request while a Save dialog or discard prompt is active;
  the request must queue and protect newer text edits and normalization changes.
- Test Finder/Explorer/Linux file-manager opening and `.md`/`.markdown`
  associations. A missing path must stay absent until Save.
- Open/save through a symlink or linked folder (where available): the link stays
  intact and the target file receives the edit.
- Modify or delete the open file externally: Cancel preserves editor and disk;
  Overwrite/Recreate requires explicit approval.
- Save As to a new file and an existing file; cancel both native dialogs.
- Confirm read-only/write failures leave the document dirty with a useful error.
- Check native menus, icon, zoom, System theme, F6 focus cycling, Vim relative
  numbers, large-document scrolling and manual preview Refresh.

## Results

| Platform | Automated tests / package | Native smoke tests |
| --- | --- | --- |
| macOS Apple Silicon (M4) | 80 JS and 21 Rust/CLI tests, fmt and Clippy passed; signed app and verified DMG built; hosted checks/package/signature passed | Mixed/BOM byte round trip, CRLF normalization, undo/redo and dirty tracking passed; user verified incoming-open Keep editing/Discard; broader checks pending |
| macOS Intel | Hosted checks/package/signature passed (cross-build) | Pending |
| Windows 11 x64 | Hosted checks and EXE/MSI builds passed | User verified MSI testing; fonts stable; Normalize line endings appears in Edit |
| Arch Linux x86-64 | Hosted checks and AppImage/DEB/RPM builds passed | User verified AppImage testing; fonts stable; Normalize line endings appears in Edit |

The user reports: “test verified with msi installer on windows 11 and app image
on Archlinux. Fonts were stable and normalize option appeared in edit menu.”
The report confirms package smoke testing and the observations listed above;
individual hash comparisons, normalization styles and CLI/native regression
results have not been recorded separately. Remaining detailed checks stay in the
release checklist.

The M4 downloaded-install check passed: the user copied the fresh 0.1.4 DMG app
to Applications and launched it through Privacy & Security → Open Anyway without
manual re-signing. Every installed app file matches the downloaded release, its
strict signature check passes, and the downloaded DMG checksum verifies. Fresh
M1 installation and native Intel launch remain unverified. Detailed pending tests
are retained in the release checklist; they are not claimed as completed.


## M4 command-line follow-up

The packaged 0.1.4 binary passed `--help`, `--version` and exit-2 error checks
for unknown options, multiple files, bare `--`, remote URLs and incomplete file
URLs. All five Rust launch-parser tests pass. Its Info.plist contains `.md` and
`.markdown` Editor associations with Alternate rank.

The user subsequently verified native incoming-file opening on M4: the supplied
screenshot shows `hotkeys_reference.md` opened and rendered. With unsaved edits,
Keep editing cancelled the incoming open and retained those edits; repeating the
request with Discard opened the new file.

The user also verified the Save As queue flow: the unsaved-change prompt appears
once afterward and does not repeat. Screenshots of the installed app's CLI opening
`/tmp/textgate-missing-test.md` show an empty named document, ABSENT on disk before
Save, and EXISTS after Save. The user then edited that saved file in another
editor and confirmed Textgate displays the changed-on-disk warning on Save.
Explicit Overwrite then produced disk contents matching Textgate, including the
“Yes” to “no” change. Moving the open file to Trash triggered the expected
Cancel/Recreate dialog (screenshot): Cancel retained the buffer and left the
original path absent; Recreate created a new file at that path while keeping the
trashed copy intact. Save As to a new filename produced a matching buffer copy.
The user also verified Save As replacement with an overwrite warning and confirmed
that cancelling Save As behaves as expected.

The missing-file CLI invocation reached the running app. The user subsequently
quit Textgate completely and verified that the installed binary opened
`first-launch.md` in one window. With Textgate running, a relative invocation
from `/tmp/textgate-cli-checks` opened `spaces and café.md` in that same window.
The `-- -dash.md` invocation and `file:///tmp/textgate-cli-checks/file-url.md`
also opened the expected files. These confirm Mac first-launch, second-instance
forwarding, relative paths, spaces/Unicode, dash-prefixed names and local file URLs.

The user also verified that Zed creating a file at the same prepared-but-unsaved
path triggers an overwrite confirmation in Textgate. CLI first-launch, forwarding
and path checks on Windows/Linux remain pending. Detailed save-integrity checks on Windows/Linux and
downloaded Mac installation checks remain separate pending items. Desktop automation was unavailable during the
automated pass, including after reconnecting.
From the repository root, with the generated fixture directory present:

```sh
textgate_bin="$PWD/target/aarch64-apple-darwin/release/bundle/macos/Textgate.app/Contents/MacOS/textgate"
"$textgate_bin" target/save-fixtures-0.1.4/mixed-bom.md
```

On first launch, the mixed/BOM fixture should open. In another Terminal tab, use
the same absolute binary path to open `crlf-bom.md`. It should reach the existing
window. Repeat with an unsaved edit: Keep editing must preserve the current
buffer, while Discard must open the requested file. Repeat with an active Save
As dialog and confirm the incoming request waits for that operation to finish.

Also run from a different working directory and test a path with spaces/Unicode,
`-- -name.md`, a local file URL and Finder Open With. Inspect the actual document
and dirty marker before marking those checklist items complete.
