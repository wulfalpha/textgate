# Textgate

A lightweight desktop Markdown editor built with Rust, Tauri 2, CodeMirror 6, and comrak.

**Status: early release.** v0.1.3 is the first official release, with downloads
for Linux, Windows, and macOS (Apple Silicon and Intel). See the
[v0.1.3 notes](docs/releases/0.1.3.md), the [release checklist](docs/release-checklist.md),
and the [contributor guide](CONTRIBUTING.md).

The current source prepares **v0.1.4** with command-line/file-manager opening and
explicit Mac ad-hoc signing. These changes are not in the v0.1.3 downloads.
See the [0.1.4 release notes](docs/releases/0.1.4.md).

![Textgate in Live mode: headings, task list, link, and table rendered in place](docs/screenshots/live.png)

The [Textgate logo](docs/branding/README.md) combines a segmented omega
with code-bracket feet, with a vector master and desktop icon exports.

**Your Markdown file is the document.** Textgate never re-serializes it: the only
changes saved are the ones you type or the formatting commands you run, and those
touch only the markup they add or remove. Consistent line endings (LF, CRLF or CR)
and a UTF-8 byte order mark are preserved on save. Mixed line endings are
normalized to the most frequent style; an opening status message reports this. Files that are not valid UTF-8 are
refused rather than opened lossily. The app uses vanilla JavaScript and CSS with
Vite; no UI framework is required.

## Saving documents

Saves write and flush a temporary file in the document's directory before
replacing the original. Existing file permissions are preserved. Before saving,
Textgate compares the disk bytes with the version last opened or saved. If the
file changed or disappeared, you can cancel or explicitly overwrite/recreate it.
Cancel keeps your edits in the editor; Save As lets you keep a separate copy.
If you try another menu file action or close the window while an operation is
running, the status bar asks you to finish or cancel that operation and try again.
Closing is not queued. Incoming command-line/file-manager opens do queue and ask
before replacing unsaved work once the current operation finishes.

This detects external changes but does not lock out other editors during the
final replacement. Directory syncing is best effort. Symbolic links, special
files, and (on Unix) files with multiple hard links are rejected; choose a regular
file instead. Replacement preserves ordinary permissions, but does not promise
to preserve ownership, extended attributes, or every platform's ACL metadata.

## Live and Source modes

Both modes are the same editor with one undo history, so switching never changes
the text, and Vim bindings work in both.

- **Live** (default) styles Markdown in place: headings, emphasis, links, quotes,
  lists, code, and rules render as formatted text, and their markup is hidden
  except on the lines you are editing. Task checkboxes are clickable (toggling
  only the `x`). Tables render as tables; click one, or move the cursor into it,
  to edit its Markdown. HTML, front matter, and link definitions are shown as
  source.
- **Source** shows plain Markdown beside a rendered preview.

![Source mode with the comrak preview](docs/screenshots/source.png)

The toolbar (Live mode) sets headings, toggles bold, italic, strikethrough, inline
code, lists, task lists, quotes, and code blocks, inserts tables, and adds, edits,
or removes links. Ctrl/Cmd+B and Ctrl/Cmd+I work in both modes. Enter continues
lists and quotes.

The preview is rendered in Rust by [comrak](https://github.com/kivikakk/comrak),
a port of GitHub's cmark-gfm, with tables, task lists, strikethrough, autolinks,
footnotes, GitHub alerts (`> [!NOTE]`), and heading anchors; YAML front matter is
not rendered when enclosed by `---` lines at the start of the document.
Output is sanitized with DOMPurify. Browser-only `npm run dev` has no
Rust backend and falls back to `marked`, which can differ in edge cases.

## Large documents

Live-mode styling is limited to visible text and a nearby margin. Tables and
multiline markup still reveal their source when selected. Tables larger than
50,000 characters stay as editable source in Live mode to avoid creating a huge
widget; the Source preview can render them on request.

Word counts and complete outlines are computed in a background worker after a
typing pause (120 ms for small documents, 300 ms from 100,000 characters, and
600 ms from 1,000,000). Outdated jobs are cancelled. Outline buttons are reused,
and long outlines initially show 250 headings with a **Show more headings** button.

At 1,000,000 characters or more, the Source preview updates only when you click
**Refresh**. The preview notice identifies when it needs updating. Smaller
documents retain automatic preview updates. These limits count UTF-16 code units,
so they are approximate character counts, not file sizes in bytes.

## CSS themes

Open **View → Themes…** and use the **Theme** picker. Textgate creates editable `light.css`
and `dark.css` files on first use, preserving existing files. **Default** always
restores the built-in light appearance, even if you have edited `light.css`.
**System (light or dark)** follows your operating system: the built-in light
appearance, switching to your `dark.css` whenever the system is in dark mode.

Theme files live in:

- Linux: `$XDG_CONFIG_HOME/textgate/themes/`, or `~/.config/textgate/themes/`
  when XDG_CONFIG_HOME is unset/empty (relative XDG paths are ignored).
- macOS: `~/Library/Application Support/textgate/themes/`.
- Windows: `%APPDATA%\textgate\themes\`.

The Themes dialog shows the exact directory used by your installation. Copy a starter
theme to `my-theme.css`, edit it, then press **Reload** to refresh the picker and
apply changes. Reload is manual; no restart is needed. The selected filename is
saved in `textgate/theme.txt` beside the themes directory and restored at startup.
Theme files must be UTF-8, regular `.css` files, at most 1 MiB (no symlinks).

Themes are ordinary CSS appended after the app stylesheet. You can override any
selector, but the `--tg-*` custom properties are the easiest way to cover the app,
live editor, source editor, and preview consistently. For example:

```css
:root {
  --tg-accent: #7651b5;
  --tg-on-accent: white;
  --tg-font-document: Georgia, serif;
}
```

Copy `dark.css` for a complete dark palette, including `color-scheme: dark` for
native form controls. The starter files list all color/font properties. Syntax
colors use `--tg-syntax-keyword`, `--tg-syntax-string`, and `--tg-syntax-number`;
source token classes such as `.tok-heading` can also be styled directly.

Choose **Default** or press **Ctrl/Cmd+Alt+0** to reset, even if custom CSS hides
the controls. Unreadable/missing saved themes fall back to Default with a status
message. Invalid CSS declarations are ignored by the webview. Themes should be
self-contained: relative config-directory assets/imports are not resolved and the
app's existing content security policy still restricts external resources.
Browser-only `npm run dev` uses Default; config-file themes require the desktop app.

## Install a release

Packages appear on the [GitHub Releases page](https://github.com/wulfalpha/textgate/releases)
after a release is published. Draft downloads are visible only to repository
collaborators with access.

| Platform | Download |
| --- | --- |
| Linux x86-64 | `.AppImage`, `.deb` for Debian/Ubuntu, or `.rpm` for RPM-based distributions |
| macOS Apple Silicon | `aarch64.dmg` |
| macOS Intel | `x64.dmg` |
| Windows x64 | `x64-setup.exe` or `x64_en-US.msi` |

For the Linux AppImage, make the downloaded file executable and run it:

```sh
chmod +x Textgate_0.1.3_amd64.AppImage
./Textgate_0.1.3_amd64.AppImage
```

Open the macOS DMG and copy Textgate to Applications. Mac builds from the current
source are explicitly ad-hoc signed in Tauri and their bundle signature is
verified by the release workflow. They are not Developer ID signed or notarized,
so Gatekeeper can still block a downloaded copy.

For a trusted Textgate download, remove only its quarantine attribute after
copying it to Applications, then open it normally:

```sh
xattr -dr com.apple.quarantine "/Applications/Textgate.app"
```

This is the interim installation workaround; manual re-signing is not part of
the installation steps. It does not notarize the app or fix other launch errors.
The explicit signing/verification change is after v0.1.3; existing release files
are unchanged. Fresh M1 and M4 download tests are still needed for the new build.
See [Tauri's ad-hoc signing guidance](https://tauri.app/distribute/sign/macos/#ad-hoc-signing).

On Windows, run either installer. Windows installers are unsigned; if SmartScreen
warns for a download you trust, choose **More info → Run anyway**. Linux packages
still need compatible system libraries; an AppImage is not a guarantee of
compatibility with every distribution.

## Command-line and file-manager opening (0.1.4)

Textgate opens one file per invocation in a single editor window:

```sh
textgate notes.md
textgate "notes with spaces.md"
textgate ../project/notes.md
textgate -- -notes.md
textgate --help
textgate --version
```

Use the executable's full path if it is not on your PATH. This feature does not
install a shell command or change your PATH. From a source build, use
`./target/release/textgate notes.md`; an AppImage accepts the same arguments.
On Windows, invoke the installed `textgate.exe` (quote its path if needed).

On macOS, existing files can be opened through Launch Services:

```sh
open -a Textgate "/absolute/path/to/notes.md"
```

To use CLI options or prepare a file that does not exist yet, invoke the bundle
executable directly:

```sh
/Applications/Textgate.app/Contents/MacOS/textgate new.md
```

Relative paths are resolved against the invoking process's working directory,
including when Textgate is already running. Local `file://` URLs are accepted.
A missing file opens as an empty named document and is created only when saved;
its parent folder must already exist. If another program creates it first, the
save-conflict prompt protects that new disk version. Non-UTF-8 content is rejected.

Launching again brings the existing window forward. A request for the same path
already shown keeps your edits; it does not reload from disk. Requests received
during a save/dialog wait and then use the usual unsaved-change confirmation.
No arguments just launches or focuses the app. Multiple paths, stdin, `--wait`,
and opening at a line/column are not supported in this release. Help/version and
invalid-argument errors exit without opening a window; a forwarded file request
returns before the user completes any prompts in the existing window.

Bundles register `.md` and `.markdown` file associations. Use your file manager's
**Open With → Textgate** or choose Textgate as the default in OS settings. Finder
uses native file-open events; Windows and Linux pass launch arguments. Installed
DEB/RPM and Windows packages supply the integration; a standalone AppImage still
needs desktop integration to appear in Open With. File-manager behavior must be
verified on each packaged platform before release.

## Build and run from source

Install a current stable Rust toolchain, Node.js 24 (used in CI), and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
On Linux these include GTK 3 and WebKitGTK 4.1 development packages.

```sh
npm ci
npm run tauri dev
```

The Rust crate and Tauri configuration live at the repository root. `npm run dev`
runs only the browser UI; native file operations require the desktop app.

```sh
npm test
npm run build
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm run tauri build
```

The last command builds the executable in `target/release/` and installers in
`target/release/bundle/`: `.deb` and `.rpm` on Linux, `.app` and `.dmg` on macOS,
and NSIS and MSI installers on Windows. Mac bundles are ad-hoc signed without
notarization; Windows installers are unsigned.

The default local build does not produce an AppImage. The release workflow
explicitly requests one and builds Linux packages on Ubuntu 22.04 to reduce the
minimum glibc requirement. Building successfully on a newer local distribution
does not establish that an AppImage will run on older distributions.

Pushing a `v*` tag builds Linux x86-64, Windows x64, and both Mac architectures,
runs the JavaScript tests on each runner, and attaches packages to a draft GitHub
Release. Running the release workflow manually produces workflow artifacts
without creating a release. The separate push/PR Checks workflow runs the full
JavaScript, Rust, formatting, and Clippy checks on Linux, macOS, and Windows.

## Keyboard shortcuts

The desktop app has native **File**, **Edit**, **View**, and **Help** menus.
On macOS, About and Quit appear in the application menu. Browser-only development
uses an in-page menu bar. The Live/Source switch and formatting toolbar
remain visible; View controls the outline, preview pane, Vim bindings, line numbers, and themes.

| Action | Shortcut |
| --- | --- |
| New | Ctrl/Cmd+N |
| Open | Ctrl/Cmd+O |
| Save | Ctrl/Cmd+S |
| Save as | Ctrl/Cmd+Shift+S |
| Quit | Ctrl/Cmd+Q |
| Zoom in / out / actual size | Ctrl/Cmd+= / - / 0 |
| Check or uncheck tasks on the selected lines | Ctrl/Cmd+Shift+X |
| Move between outline, editor and preview | F6 / Shift+F6 |

Choose **View → Vim bindings** to enable Vim editing in either mode. The status
bar shows the current Vim mode. **View → Relative line numbers** shows the
cursor line's number and every other line's distance from it, as Vim's
`number` plus `relativenumber` does; it also shows the numbers in Live mode.
**View → Zoom In/Out** scales the whole window and is remembered on this device.
Lines in right-to-left scripts such as Arabic and Hebrew read right to left
in the editor and the preview.
Standard CodeMirror editing,
undo, search, and selection shortcuts are available otherwise.
Fenced code blocks use their language label (such as `python`, `py`, or `rust`)
for syntax highlighting; language parsers load on demand from bundled assets.
Unknown or unlabeled fences remain plain code. Tab indents and
Shift+Tab unindents the current line or selected lines. To move keyboard focus
out of the editor, press Escape followed by Tab.

## Scope and next steps

Next milestones:

- Table row/column commands for Live mode.
- Folder explorer and sidebar tabs.
- Local image resolution and external link opening (preview links currently show
  their destination in the status bar; remote images are blocked in the desktop app).
- Continued package validation across supported platforms.

Only a single document is open at a time. New/open/close ask before discarding
unsaved changes. There is no crash recovery or autosave yet. File permissions are
restricted to paths granted through native file dialogs or native launch/file-open
requests, plus the dedicated Textgate theme configuration handled by the Rust backend.

## License

Textgate is licensed under the [MIT License](LICENSE).
