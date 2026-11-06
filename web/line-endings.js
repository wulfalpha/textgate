import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { defaultFormat, documentFormat } from './document-format.js';

const labels = {
  '\n': ['↵', 'LF (line feed)'],
  '\r\n': ['␍↵', 'CRLF (carriage return and line feed)'],
  '\r': ['␍', 'CR (carriage return)'],
};
class LineEnding extends WidgetType {
  constructor(ending) { super(); this.ending = ending; }
  eq(other) { return other.ending === this.ending; }
  toDOM(view) {
    const marker = view.dom.ownerDocument.createElement('span');
    const [symbol, title] = labels[this.ending];
    marker.className = 'cm-line-ending';
    marker.textContent = symbol;
    marker.title = title;
    marker.setAttribute('aria-hidden', 'true');
    marker.setAttribute('contenteditable', 'false');
    return marker;
  }
  ignoreEvent() { return true; }
}

// Mark real saved line endings, not visual wrapping or the unterminated last
// line. Work only over visible ranges, including in large documents.
export function lineEndingMarkers() {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(update) {
      if (update.docChanged || update.viewportChanged ||
          update.startState.field(documentFormat, false) !== update.state.field(documentFormat, false)) {
        this.decorations = this.build(update.view);
      }
    }
    build(view) {
      const { state } = view;
      const format = state.field(documentFormat, false) ?? defaultFormat;
      const markers = [];
      const seen = new Set();
      for (const { from, to } of view.visibleRanges) {
        const last = Math.min(state.doc.lineAt(to).number, state.doc.lines - 1);
        for (let number = state.doc.lineAt(from).number; number <= last; number++) {
          if (seen.has(number)) continue;
          seen.add(number);
          const line = state.doc.line(number);
          const ending = format.endings?.[number - 1] ?? format.lineEnding;
          markers.push(Decoration.widget({ widget: new LineEnding(ending), side: 1 }).range(line.to));
        }
      }
      return Decoration.set(markers, true);
    }
  }, { decorations: (plugin) => plugin.decorations });
}

const key = 'textgate.show-line-endings';
export function readShowLineEndings(storage) {
  try { return storage?.getItem(key) === 'on'; } catch { return false; }
}
export function storeShowLineEndings(storage, enabled) {
  try { storage?.setItem(key, enabled ? 'on' : 'off'); } catch { /* keep the session setting */ }
}
