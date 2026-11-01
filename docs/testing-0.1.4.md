# Testing Textgate 0.1.4

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
| macOS Apple Silicon (M4) | 80 JS and 21 Rust/CLI tests, fmt and Clippy passed; signed app built | Mixed/BOM byte round trip, CRLF normalization, undo/redo and dirty tracking passed; broader checks pending |
| macOS Intel | Hosted build pending | Pending |
| Windows x64 | Hosted tests/build pending | User testing pending |
| Linux x86-64 | Hosted tests/build pending | User testing pending |

Keep the GitHub release a draft until package uploads and the agreed smoke tests
have been reviewed. Draft downloads require repository collaborator access.
