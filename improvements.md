# Textgate review and suggested improvements

Reviewed at commit `4189440` (main, 2026-10-27). CI on that commit is green.

## What it is

Textgate is a Tauri 2 desktop Markdown editor (Tauri 2.12.4).

- **Backend:** Rust, about 230 lines in `src/`. It has two commands. `render_markdown` uses comrak 0.59 with GFM options. `theme_state` handles user CSS themes under the config dir.
- **Frontend:** vanilla JS, about 1,100 lines of app code in `web/` plus about 540 lines of tests. It uses CodeMirror 6 for both editing modes: "Live" (in-place styling with hidden markup) and "Source" (split view with a comrak preview). The preview is sanitized with DOMPurify 3.4. `marked` is a fallback for browser-only dev.
- **Size:** about 14k tracked lines, of which about 2.1k are first-party code and CSS. Most of the rest is lockfiles. `vite build` output is 2.1 MB; the main chunk is 878 kB, or 294 kB gzipped.
- **Design:** the Markdown text is the document. It is never re-serialized, and the BOM and line endings are preserved. That is the right call, and the code mostly keeps that promise.
- **Overall:** clean, small and well-commented code with a thoughtful security baseline: CSP, DOMPurify, dialog-scoped fs permissions, and a symlink-safe theme loader.

## How I tested

- `npm ci`, `npm test` (28/28 pass on Node 20.19) and `npm run build` (succeeds).
- **Not built:** the Rust/Tauri crate. The box couldn't install `libwebkit2gtk-4.1-dev` because the Debian mirrors were unreachable, so `cargo test` / `clippy` / `tauri dev` weren't run here. CI runs them.
- **comrak:** the app's exact `options()` from `src/markdown.rs`, compiled into a scratch crate, rendering the edge-case inputs below.
- **App in a browser engine:** the built web UI (`vite preview`) in headless Chrome 156 via CDP, to verify DOM bugs and measure typing latency. That is browser mode, which uses `marked` instead of comrak.
- **jsdom:** probes for the formatting commands, encodings, sanitizer and decoration cost.
- **Probe scripts:** in `probes/` next to this file. Every finding below is marked **[verified]** (reproduced by running) or **[by reading]**.

---

## 1. Bugs (fix first)

### 1.1 Preview content can hijack the app's own DOM ids [verified]

**Where:**
- `src/markdown.rs:13`: `header_id_prefix = Some("")`.
- `web/markdown.js:40-45`: DOMPurify keeps `id`.
- `web/main.js:26`: `$ = getElementById`.

**What happens:** comrak gives every heading a bare id (`# Status` → `id="status"`, `## Link dialog` → `id="link-dialog"`, also `save` and `preview`), and raw HTML `<span id="...">` survives sanitizing. The `<article id="preview">` comes before the `<footer>` and the `<dialog>`s in tree order, so `document.getElementById` returns the user's element instead of the app's.

**Observed in Chrome:**
- With `<h1 id="status">` in the doc, the status message from Save was written *into the preview heading*. The real status bar stayed "Ready".
- With `id="link-dialog"`, the Link button no longer opens the link dialog (`$('link-dialog').showModal` is not a function).
- comrak was confirmed to emit `id="status"` and `id="link-dialog"` for ordinary headings named "Status" or "Link dialog". In the desktop app, a document with a heading called "Status" is therefore enough to break the status bar.

**Fix:**
- Do what GitHub does: set `header_id_prefix = Some("user-content-".into())` and DOMPurify `SANITIZE_NAMED_PROPS: true`. That option prefixes user `id`/`name` with `user-content-`.
- In the preview click handler, resolve `#foo` to `user-content-foo`.
- Also cache app element refs at startup, or scope lookups to the shell, rather than calling `getElementById` everywhere.
- Add a regression test.

### 1.2 `<dialog open>` in a document freezes every shortcut and menu action [verified]

**Where:**
- `web/main.js:199`: the keydown handler bails if `dialog[open]` exists anywhere.
- `web/menus.js:48`: native menu actions bail the same way.
- `web/menus.js:84-86`: the observer disables all menu items.

**Why it happens:** DOMPurify allows `<dialog open>`.

**Observed:** a 440×74 px overlay in the preview, and Ctrl+S did nothing (`defaultPrevented: false`, no status). The stale preview DOM stays in the hidden pane after switching to Live, so the freeze persists in Live mode. The user can't save via shortcut or menu until they delete the HTML.

**Fix:**
- Forbid `dialog` (and see 2.1 for the other interactive tags).
- Check only the app's own dialogs: `document.querySelector('body > dialog[open]')`, or keep a set of them.
- Clear `#preview` when leaving Source mode.

### 1.3 Clicking a preview link with a malformed `%` escape throws [verified]

**Where:** `web/main.js:215`, where `decodeURIComponent(href.slice(1))` is called without try/catch.

**Observed:** `[bad](#%E0%A4%A)` → `Uncaught URIError: URI malformed` in Chrome.

**Fix:** wrap it in try/catch and fall back to the raw fragment.

### 1.4 Insert Table swallows the next line of text [verified]

**Where:** `web/markdown-commands.js:115-120`.

**What happens:** on a non-empty line, the table is inserted after the line with `\n\n` before it but nothing after it. If the next line has text, it becomes a table row.

**Observed:** `"Intro\nNext para"` → `"...|  |  |\nNext para"`, and comrak renders `<td>next paragraph</td>`.

**Fix:** append `\n\n` (or `\n` if the following line is already blank) after the table.

### 1.5 Paragraph-style menu on a Setext heading leaves the underline [verified]

**Where:** `web/markdown-commands.js:59-63`.

**Observed:** `Title\n=====` with Heading 2 selected → `## Title\n=====`. The `=====` then renders as a stray paragraph (confirmed with comrak).

**Fix:** detect `SetextHeading*` via the syntax tree and remove the underline line, or convert it to the matching level.

### 1.6 Link dialog doesn't escape the label [verified]

**Where:** `web/markdown-commands.js:143-144`.

**Observed:** selecting `a]b` and applying a link gives `[a]b](https://x)`. comrak renders it as literal `[a]b](` plus an autolink.

**Fix:** escape `[`, `]` and `\` in the label (`label.replace(/[\\[\]]/g, '\\$&')`).

### 1.7 Quote toggle adds a level instead of removing one when the selection has a blank line [verified]

**Where:** `web/markdown-commands.js:87-90`. The `every()` check counts blank lines, and those never match `/^ {0,3}> ?/`.

**Observed:** `> a\n\n> b` (all selected) → `> > a\n>\n> > b`.

**Fix:** ignore blank lines in the `remove` check, the way `toggleList` already does (line 74).

### 1.8 Front matter closed with `...` is hidden in the editor but rendered in the preview [verified]

**Where:** `web/markdown.js:6` accepts `---` *or* `...` as the closing fence. comrak (`src/markdown.rs:14`) accepts only `---`.

**Observed:** `---\ntitle: x\n...\n# After` renders as `<hr>` plus a paragraph `title: x ...` in the preview, while Live mode and the outline treat it as front matter.

**Fix:** pick one rule. The simplest is to drop `...` from the JS regex.

### 1.9 Window close is silently ignored while anything is busy [by reading]

**Where:** `web/main.js:221-223` and `123-127`.

**What happens:** `onCloseRequested` always calls `preventDefault()`, then `run()`. If another action is in flight (an Open/Save dialog, a confirm, a slow write), `run` returns immediately because `busy` is set, so the window just doesn't close and no message is shown.

**Fix:** queue the close, or show a status message ("Finish saving first").

### 1.10 Minor bugs

- **Bold over partially bold text nests markers** [verified]. `a **b** c` (all selected) → `**a **b** c**`. Strip the inner markers or refuse. Where: `web/markdown-commands.js:24-35`.
- **Mixed line endings are normalized without asking** [verified]. `a\r\nb\nc\r\n` round-trips to all-CRLF. The status bar mentions it, but a one-time confirm before the first save would match the "never rewrites your file" promise.
- **UTF-16 files are refused** [verified], with "not valid UTF-8". Detecting the `FF FE` / `FE FF` BOM and saying "UTF-16 isn't supported yet" would be clearer. Where: `web/document-format.js:9-14`.

---

## 2. Security

The baseline is good. I tried these payloads against `sanitize()`: `<script>`, `onerror`, `<svg onload>`, `<svg><script>`, MathML `xlink:href`, `javascript:` (including the entity-encoded `jav&#x61;script:`), `file://`, `asset://`, `tauri://`, `<meta refresh>`, `<base>`, `<link>`, `<object>/<embed>`. All were stripped [verified]. CSP `script-src 'self'` with no `'unsafe-inline'` is a second wall. Preview clicks are all `preventDefault`ed, so nothing can navigate the webview.

### 2.1 Tighten the sanitizer to an allowlist [verified]

**Where:** `web/markdown.js:41-45`.

**Still allowed today:** `<dialog open>` (see 1.2), `<textarea>`, `<select>`, `<button id=...>`, `<details>`, `<video autoplay src=https://...>`, and arbitrary `id`/`class`. The comment says "preview content is never interactive", but form controls survive.

**Fix:** use `ALLOWED_TAGS` set to the GFM output set (p, h1-6, a, img, ul/ol/li, table parts, pre/code, blockquote, em/strong/del, sup/sub, hr, br, section, details/summary, div/span, kbd, input[type=checkbox]). Add `SANITIZE_NAMED_PROPS`, and `ALLOWED_URI_REGEXP` limited to https, http, mailto, `#` and relative.

### 2.2 comrak emits `javascript:` URLs; DOMPurify is the only filter [verified]

With `render.unsafe = true` (`src/markdown.rs:15`), `[x](javascript&#58;alert(1))` becomes `href="javascript:alert(1)"`. DOMPurify removes it today, but any future code path that skips `sanitize()` would be exposed. That includes a future HTML export, a print view, or the table widget if it's refactored.

**Fix, either of:**
- (a) Keep `unsafe` but enable comrak's `extension.tagfilter = true` and add a Rust test asserting no `javascript:` survives `render → sanitize`.
- (b) Render with `unsafe = false` unless the user opts in to raw HTML.

Also add a JS test that runs real comrak output, not a mocked `<p>ok</p>`, through `sanitize`.

### 2.3 External links and local images

Preview links only show their destination in the status bar, and `img-src asset:` in the CSP has no effect because `assetProtocol` isn't enabled.

When you add link opening, use `tauri-plugin-opener` with an allowlist (http, https, mailto) and a confirm step for anything else. For local images, enable the asset protocol scoped to the open document's directory only, not `$HOME`.

### 2.4 Themes [by reading]

`read_theme` (`src/themes.rs:26-39`) is careful: no separators, `.css` only, no symlinks, 1 MiB cap.

- There's a tiny TOCTOU gap between `symlink_metadata` and `read_to_string`. Opening once and checking the metadata from the handle closes it.
- On Windows, also reject `:` so alternate data streams like `a:b.css` can't be used.
- Themes are inserted as `<style>` text, so they can't run script. CSP `style-src 'unsafe-inline'` is needed for this, and that's acceptable.

---

## 3. Performance

### 3.1 Live mode rebuilds every decoration over the whole document on every keystroke and cursor move [verified]

**Where:** `web/live-preview.js:73-91` and `:186`. A `StateField` calls `build()` over `syntaxTree(state).iterate()` for the entire document on every `docChanged` *or* `selection` change.

**Measured in jsdom** (fully parsed tree, per cursor move):

| Document size | Time per cursor move |
| --- | --- |
| 100 KiB | 12 ms |
| 1 MiB | 146 ms |
| 5 MiB | 705 ms |

**Measured in Chrome** (typing latency per character):

| Document size | Live mode | Source mode |
| --- | --- | --- |
| 200 KiB | 29 ms | 10 ms |
| 1 MiB | 109 ms | 27 ms |

**Fix:**
- Move the inline decorations to a `ViewPlugin` that builds only for `view.visibleRanges`, the standard CodeMirror pattern.
- Keep only the block-level replacements (tables) in a StateField. CodeMirror requires block widgets to come from state. Map them through changes instead of rebuilding.

### 3.2 Per-keystroke whole-document work in `refresh()` [verified]

- `dirty()` (`web/main.js:46`) does `doc.toString() !== savedText` on every change: 2 ms at 1 MiB, 34 ms at 5 MiB.
  - **Fix:** track a saved-state marker instead, e.g. compare `view.state.doc` to a saved `Text` with `eq()`, or count changes since save.
- `refreshDetails()` (`web/main.js:64-81`) runs 120 ms after each pause. It re-splits the whole text for the word count (18 ms at 1 MiB), rebuilds every outline button (6k DOM nodes at 1 MiB), and sends the whole document over IPC to comrak.
  - comrak itself is fast: a 6 MiB document rendered in 0.61 s in release mode, and pathological nesting or brackets took under 10 ms.
  - **Fix:** diff the outline, compute word counts incrementally or lazily, and lengthen the debounce for big docs (e.g. skip the live preview above N MB with a "Refresh preview" button).
- `headings()` calls `ensureSyntaxTree(..., 200)`, so it can block for up to 200 ms each refresh on large files (`web/markdown.js:12`).

### 3.3 Bundle size [verified]

`marked` is statically imported (`web/markdown.js:1`) and ends up in the desktop main chunk even though the desktop never uses it. Switch to `await import('marked')` in the browser branch. Vite also warns about the 878 kB chunk; CodeMirror's language data is already split, which is good.

---

## 4. UX and features (a markdown editor's basics)

1. **External file changes aren't detected** [by reading; nothing in the code watches files].
   - The risk: if the file changes on disk (git pull, Syncthing, another editor), Save silently overwrites it.
   - **Fix:** record mtime, size and hash on open. Check before save ("file changed on disk: overwrite / reload / compare"). Optionally watch with `tauri-plugin-fs` `watch` or the `notify` crate and offer a reload when the buffer is clean.
2. **Atomic save** (already on the roadmap). `writeTextFile` truncates and then writes (`web/main.js:147`), so a crash or a full disk can lose the original.
   - **Fix:** do it in a Rust `save_document` command. Write to a temp file in the same dir, fsync, keep the original permissions, then rename. That also gives better error messages for read-only or missing directories.
3. **Open from the command line or file manager.** `textgate notes.md` doesn't open the file, because nothing reads argv and there are no file associations. This is a big deal for a Linux-first editor.
   - **Fix:** use `std::env::args` plus `tauri-plugin-single-instance`, emit an open event to the webview, and add `fileAssociations` in the bundle config later.
4. **Crash recovery or autosave** to the app data dir every N seconds while dirty.
5. **RTL text** [verified]. Arabic lines render with `direction: ltr` in both the editor and the preview.
   - **Fix:** add `dir="auto"` on `#preview` block elements. For the editor, use CodeMirror's `EditorView.perLineTextDirection.of(true)`.
6. **Zoom and font size.** All sizes are fixed px (the editor is 13 px) and `zoomHotkeysEnabled` isn't set in `tauri.conf.json`. Enable it, or add Ctrl +/−/0 that scales the `--tg-*` font variables.
7. **Follow the system dark mode.** Default is always light. Add a "System" theme choice that uses `prefers-color-scheme`.
8. **Preview scroll sync** between the editor and the preview in Source mode.
9. **Drag-and-drop to open** a `.md` file onto the window. Tauri has a drag-drop event.
10. **Recent files** list in the File menu.

---

## 5. Accessibility

- `#dirty` (`index.html:5`) is a `<span aria-label>` with no role, and screen readers ignore `aria-label` on generic spans.
  - **Fix:** use visually hidden text ("Unsaved changes"). The window title already shows "•", which helps.
- The preview's task symbols (`web/markdown.js:50-52`) use `aria-label` on a span, which has the same problem. Use `role="img"` plus `aria-label`, or hidden text.
- Live-mode checkboxes toggle only on `mousedown` (`web/live-preview.js:39-43`). Keyboard users can still edit the `[ ]` text, but a keyboard command for "toggle task" would be nicer.
- Escape-then-Tab to leave the editor is documented. Also add a visible skip link or an F6 cycle between the outline, editor and preview.
- Fixed px fonts with no zoom (see 4.6) is the biggest accessibility gap.
- `:focus-visible` outlines exist for buttons. Check the outline and preview panes, and check the contrast of `--tg-muted` on `--tg-surface` in both themes.

---

## 6. Architecture and code quality

- The code is small, readable and commented with *why*, not *what*. The modules split cleanly: format, commands, live preview, menus, themes.
- `main.js` relies on module-level globals and `$()` lookups.
  - Splitting a small `documentController` (path, format, savedText, open/save) from the view would make the open/save/dirty logic testable without a DOM.
  - The native-file path isn't tested at all today: `app.test.js` only exercises browser mode.
- Add a `web/` test that runs the real Rust renderer output through `sanitize`. You could snapshot comrak HTML fixtures from `cargo test` into a JSON file the JS tests read.
- `menus.js:33` uses the deprecated `navigator.platform`. Prefer the Tauri OS plugin, or `userAgentData` with a fallback.
- `tauri.conf.json` `devUrl` is `http://localhost:1420`, but Vite binds `127.0.0.1` (`package.json` `dev`). Use `127.0.0.1` in both to avoid IPv6 `localhost` resolution problems.
- There's no `engines` field in `package.json` and no `rust-version` in `Cargo.toml`.
  - `themes.rs:55-57` uses let-chains, which need Rust ≥ 1.88. I confirmed that Rust 1.85 rejects the syntax.
  - Tests and the build do pass on Node 20.19, even though the README says 22.12+.
  - Declare `rust-version = "1.88"` and `"engines": {"node": ">=20.19"}` (Vite 7's floor), or keep 22.12 if that's intentional.

## 7. Packaging, CI and releases

- `bundle.active` is `false`. When you're ready:
  - Enable `deb`, `rpm`, `appimage`, `dmg`, `nsis`/`msi`.
  - Add a release workflow on `v*` tags using `tauri-apps/tauri-action`, with a matrix of ubuntu-22.04, macos-latest and windows-latest that attaches artifacts to a GitHub Release.
  - Consider Flatpak/Flathub and an AUR `-bin` package for Linux users.
  - Signing and notarization on macOS and Windows come later. The Tauri updater plugin needs signing keys.
- CI covers Linux only. Add a `cargo check` / `tauri build --no-bundle` matrix on macOS and Windows so the "cross-platform" goal is enforced. That also covers the release-checklist item about Windows CRLF/BOM byte-identical saves: run `document-format.test.js` there too.
- Add `Swatinem/rust-cache` to speed up CI (about 3.3 min today).
- Add Dependabot or Renovate for npm, cargo and GitHub Actions.
- Run `npm audit` (0 vulnerabilities today) and `cargo audit`/`cargo deny` in CI.

## 8. Licensing

- MIT, with a correct LICENSE file and the license field in `Cargo.toml` and `package.json`. Good.
- The dependencies are permissive: comrak is BSD-2, CodeMirror MIT, DOMPurify Apache-2.0/MPL-2.0, Tauri Apache-2.0/MIT.
- Once you ship binaries, include third-party notices, generated with `cargo about` and `license-checker`, in the bundle and the About dialog.
- The logo files in `docs/branding` should state their license. MIT by default is fine if that's intended; say so in `docs/branding/README.md`.

---

## Suggested order

1. Fix 1.1–1.3 together with 2.1 (id prefixing, allowlist sanitizer, app-only dialog check, safe decode) and add regression tests.
2. Fix the small command bugs 1.4–1.8. Each is a few lines plus a test.
3. Make Live mode viewport-only (3.1) and remove the whole-document work per keystroke (3.2).
4. Add the safe-save trio: detect external changes, atomic save, open from argv.
5. Add the RTL, zoom and system-theme fixes.
6. Packaging: release workflow and macOS/Windows CI.
