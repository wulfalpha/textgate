import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';

// Lines in right-to-left scripts (Hebrew, Arabic, Syriac, Thaana and their
// presentation forms) take their direction from their own text, as in the
// preview. Only visible lines that contain such characters are decorated.
const rightToLeft = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const auto = Decoration.line({ attributes: { dir: 'auto' } });

function build(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (rightToLeft.test(line.text)) builder.add(line.from, line.from, auto);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function textDirection() {
  return [
    ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = build(view); }
      update(update) {
        if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
      }
    }, { decorations: (plugin) => plugin.decorations }),
    // Lets cursor motion and selection follow each line's own direction.
    EditorView.perLineTextDirection.of(true),
  ];
}
