import { RangeSet } from '@codemirror/state';
import { EditorView, GutterMarker, lineNumberMarkers, lineNumbers } from '@codemirror/view';

// Hybrid relative line numbers, as Vim's `number` plus `relativenumber`: the
// cursor line shows its real number and every other line its distance from it.
const current = (state) => state.doc.lineAt(state.selection.main.head).number;

// The gutter redraws only when its markers change. This marker adds no text,
// only a class, and moves with the cursor line, so the numbers are redrawn
// when the cursor changes lines rather than on every keystroke.
const cursorLine = new class extends GutterMarker { elementClass = 'cm-lineNumber-current'; }();

export function relativeLineNumbers() {
  let cached = null;
  return [
    lineNumbers({
      // Numbers past the last line only size the gutter; keep them absolute
      // so its width fits the longest real line number.
      formatNumber: (number, state) => {
        const line = current(state);
        return String(number === line || number > state.doc.lines ? number : Math.abs(number - line));
      },
    }),
    lineNumberMarkers.compute(['doc', 'selection'], (state) => {
      const from = state.doc.lineAt(state.selection.main.head).from;
      if (cached?.from !== from) cached = { from, markers: RangeSet.of(cursorLine.range(from)) };
      return cached.markers;
    }),
    EditorView.editorAttributes.of({ class: 'cm-relative-numbers' }),
  ];
}
