import { EditorView, ViewPlugin, Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { frontMatterEnd } from './markdown-structure.js';

// CodeMirror turns the platform spell checker off for the whole editor. Turn it
// back on for prose and keep it off where words are not prose: code, URLs,
// raw HTML and YAML front matter. Browsers honour `spellcheck="false"` on
// elements inside an editable region, so mark those ranges with it.

const key = 'textgate.spellcheck';
// Node names from @lezer/markdown whose text is not prose.
export const notProse = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'URL', 'Autolink', 'HTMLTag', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);
const skip = Decoration.mark({ attributes: { spellcheck: 'false' } });

// The ranges to exclude within [from, to), in document order.
export function excludedRanges(state, from, to) {
  const ranges = [];
  const matter = frontMatterEnd(state.doc.sliceString(0, Math.min(state.doc.length, 65536)));
  if (matter > from) ranges.push([0, Math.min(matter, to)]);
  syntaxTree(state).iterate({
    from, to,
    enter(node) {
      if (!notProse.has(node.name)) return true;
      const start = Math.max(node.from, from);
      const end = Math.min(node.to, to);
      if (end > start && start >= matter) ranges.push([start, end]);
      return false;
    },
  });
  return ranges.sort((a, b) => a[0] - b[0]);
}

// Only the visible ranges are marked, as for Live mode's inline styling.
const exclusions = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = this.build(update.view);
    }
  }
  build(view) {
    const marks = [];
    for (const { from, to } of view.visibleRanges) {
      for (const [start, end] of excludedRanges(view.state, from, to)) marks.push(skip.range(start, end));
    }
    return Decoration.set(marks, true);
  }
}, { decorations: (plugin) => plugin.decorations });

export function spellcheck() {
  return [EditorView.contentAttributes.of({ spellcheck: 'true' }), exclusions];
}

export function readSpellcheck(storage) {
  try { return storage?.getItem(key) !== 'off'; } catch { return true; }
}
export function storeSpellcheck(storage, enabled) {
  try { storage?.setItem(key, enabled ? 'on' : 'off'); } catch { /* private mode: keep it for this session */ }
}
