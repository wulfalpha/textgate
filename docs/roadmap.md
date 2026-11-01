# Release plan: finish 0.1.4, then prepare 0.1.5

Reviewed 2026-10-31 against `8535bca` on main, including `969256d` ("MacOS fix")
and the following Windows fixture fix. GitHub currently lists v0.1.3 as the
latest published release; 0.1.4 is source preparation, and 0.1.5 is proposed work.

## Finish 0.1.4

Keep this release focused on macOS installation and CLI/file-manager opening.
The [cross-platform Checks run](https://github.com/wulfalpha/textgate/actions/runs/41004392254)
passed JavaScript tests, frontend builds, Rust tests, formatting and Clippy on
Linux, macOS and Windows. The Windows fixture failure is resolved; it is no
longer an outstanding code fix. No additional runtime defect was reproduced in
this documentation review.

Before tagging, complete these gates in the [release checklist](release-checklist.md):

1. Build fresh packages through the Release workflow. Verify both Mac bundle
   signatures and all expected installer assets. Checks does not build installers.
2. Download onto M1 and M4, copy to Applications, remove only the quarantine
   attribute using the README command, and verify launch without re-signing.
   Record the tested build and result for each machine. The original M1 cause
   is still unknown; an ad-hoc signature check alone cannot establish resolution.
   The user reported an M1 download/build test on 2026-10-31; the revision and
   packaged-download/quarantine-only result have not yet been specified.
3. Test installed first-launch and second-instance opening on all three platforms,
   including Finder/Explorer/Open With and Linux desktop integration. Cover another
   working directory, spaces, Unicode, local file URLs, and dash-prefixed names.
   Verify help/version in terminals, invalid and multi-file requests, cancellation
   with unsaved edits, and requests queued during a Save dialog.
4. Check create-on-save and external-creation conflicts, BOM/CRLF byte round trips,
   overwrite cancellation, deletion/recreation and write errors in packaged apps.
   A failed or cancelled open must leave the current edits intact.
5. Fix any failures found above before publishing. Keep 0.1.4 version fields and
   lockfiles aligned; inspect the draft release and update its notes with actual
   package results before publishing.

Developer ID signing/notarization remains deferred. Do not retag or replace the
existing v0.1.3 downloads to incorporate these changes.

## Proposed 0.1.5 priorities

These are recommendations, not implemented features or release promises. Start
after the 0.1.4 gates pass, and select a small scope before bumping versions.

| Priority | Proposed work | Acceptance criteria |
| --- | --- | --- |
| 1 | Crash recovery for unsaved work | Store recovery snapshots in app data without overwriting the Markdown file. Offer restore/discard after a forced termination, including an untitled buffer; preserve BOM/line-ending metadata and handle snapshot write errors. |
| 2 | Recent files | Reopen through the same native grants and discard-safe transaction. Handle moved/missing files, provide a clear-history action, and test persistence across restarts on each platform. |
| 3 | Drag-and-drop opening | Route one dropped local file through the existing scoped open queue. Preserve unsaved edits on cancellation, report unsupported or multiple files clearly, and test packaged apps on all three platforms. |

Prefer recovery first because the current app has no protection for edits lost
in a crash. Recent files and drag-and-drop build on 0.1.4's opening flow. If recovery
needs a full milestone, defer the other two rather than expanding the release.

Follow-up candidates are local image resolution/external link opening, table
row/column commands, and Source preview scroll sync. Local images and external
links need explicit native access rules and sanitized preview handling. Folder
navigation and tabs are a larger change to the current single-document model.

Maintenance candidates include matching the Vite host and Tauri dev URL
(`127.0.0.1` versus `localhost`), declaring supported Node/Rust versions, lazy
loading the browser-only Markdown fallback, and third-party notices. Validate
each against current code and toolchain requirements before implementing it.
