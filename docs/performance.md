# Large-document performance, v0.1.2

Priority 2 of the appended improvements list is implemented. Native package
smoke testing remains separate from these automated checks.

## Changes

- Inline and line decorations use `EditorView.visibleRanges`. Block widgets and
  multiline replacements remain in a StateField covering a padded viewport.
  A viewport-change effect refreshes that range after scrolling. Large replacement
  pastes do not expand it into the entire document.
- Tables over 50,000 UTF-16 code units remain source in Live mode. Line decorations
  inside long code blocks/quotes are clipped to visible ranges.
- Dirty tracking compares immutable CodeMirror Text snapshots with `eq()`, avoiding
  full string allocation per keystroke while preserving undo-to-saved semantics.
  Save completion records the snapshot actually written, not later editor edits.
- Outline parsing and word counting run in a cancellable module worker. The full
  outline no longer forces up to 200 ms of synchronous editor parsing. Unchanged
  documents reuse results, outline buttons are retained, and headings are paged.
- Details use 120/300/600 ms delays at 0/100,000/1,000,000 code units. Source previews
  at or above 1,000,000 code units are explicitly refreshed; smaller previews are
  serialized and reject stale results immediately after edits or mode changes.
- The browser fallback renderer (`marked`) loads dynamically.

## Reproducible microbenchmark

Run `npm run benchmark`. The script uses jsdom, fully parses the document before
measurement, performs 15 cursor moves and single-character insertions, discards
three warm-up samples, and reports medians. Both runs used a 2 GiB Node heap cap.
The baseline is `fcae4a9`'s Live-preview implementation, with the same script and
installed dependencies. Sizes are ASCII characters, approximately decimal bytes.

| Document | Cursor before | Cursor after | Edit before | Edit after |
| --- | ---: | ---: | ---: | ---: |
| 100,015 characters | 14.57 ms | 1.62 ms | 16.79 ms | 4.79 ms |
| 1,000,067 characters | 121.56 ms | 1.35 ms | 143.79 ms | 24.65 ms |
| 5,000,003 characters | 614.27 ms | 1.19 ms | 687.08 ms | 70.26 ms |

These are editor-dispatch timings, not native keystroke-to-paint or scrolling
latency. The sample does not include tables, syntax-highlighted code, IPC,
word counting, or the complete application UI. Parsing/edit costs still grow
with document size; this is not a guarantee of smooth editing for every 5 MB file.

## Regression coverage and remaining validation

Tests cover selection reveal, task toggling, Setext and multiline-link replacements,
distant table behavior, bounded decoration counts, oversized-table fallback,
worker cancellation/stale results, complete distant outlines, word counts,
outline pagination and retained nodes, large-document preview deferral, and
undo/dirty behavior through the application.

A browser/native UI surface was not available to the agent for visual scrolling
and paint checks. Before publishing, exercise long mixed-content documents in the
packaged app on Linux, Windows, and macOS: scroll/jump through tables and Setext
headings, select across viewport edges, switch modes, and manually refresh a large
preview. Keep those items pending in the release checklist until performed.
