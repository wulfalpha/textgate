import { syntaxTree } from '@codemirror/language';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { frontMatterEnd } from './markdown.js';

// Live preview styles Markdown in place and hides its markup away from the
// selection. It only adds decorations: the Markdown text is the document, and it
// is never rewritten. The one exception is clicking a task checkbox, which
// toggles that single character.

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'cm-lp-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const rule = document.createElement('span');
    rule.className = 'cm-lp-rule';
    return rule;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Incomplete task');
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const from = view.posAtDOM(box) + 1;
      view.dispatch({ changes: { from, to: from + 1, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// Tables are rendered by the same renderer as the preview pane, so they match it.
class TableWidget extends WidgetType {
  constructor(source, render) { super(); this.source = source; this.render = render; }
  eq(other) { return other.source === this.source; }
  toDOM(view) {
    const table = document.createElement('div');
    table.className = 'cm-lp-table';
    table.textContent = this.source;
    this.render(this.source).then((fragment) => table.replaceChildren(fragment), () => {});
    table.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(table) } });
      view.focus();
    });
    return table;
  }
  ignoreEvent() { return true; }
}

const inlineMarks = { Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' };
const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

function build(state, render) {
  const decorations = [];
  const { doc, selection } = state;
  const touches = (from, to) => selection.ranges.some((range) => range.from <= to && range.to >= from);
  const linesTouch = (from, to) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from, to) => { if (to > from) decorations.push(hidden.range(from, to)); };
  const mark = (from, to, className) => { if (to > from) decorations.push(Decoration.mark({ class: className }).range(from, to)); };
  const lines = (from, to, className) => {
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
      decorations.push(Decoration.line({ class: className }).range(line.from));
      if (line.to >= to || line.number === doc.lines) break;
    }
  };
  const isSpace = (pos) => pos >= 0 && pos < doc.length && /[ \t]/.test(doc.sliceString(pos, pos + 1));

  const start = frontMatterEnd(doc.sliceString(0, Math.min(doc.length, 65536)));
  if (start) lines(0, start - 1, 'cm-lp-source');

  syntaxTree(state).iterate({ from: start, enter: (ref) => {
    const { name, from, to, node } = ref;
    if (from < start) return;
    const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      lines(from, to, `cm-lp-h${heading[2]}`);
      if (linesTouch(from, to)) return;
      const marks = node.getChildren('HeaderMark');
      if (heading[1] === 'Setext') {
        const underline = marks.at(-1);
        if (underline) hide(doc.lineAt(underline.from).from - 1, underline.to);
        return;
      }
      marks.forEach((headerMark, index) => {
        if (index === 0) hide(headerMark.from, headerMark.to + (isSpace(headerMark.to) ? 1 : 0));
        else {
          let space = headerMark.from;
          while (isSpace(space - 1)) space--;
          hide(space, headerMark.to);
        }
      });
      return;
    }
    if (name in inlineMarks) {
      if (name === 'InlineCode') mark(from, to, 'cm-lp-code');
      if (!touches(from, to)) for (const inline of node.getChildren(inlineMarks[name])) hide(inline.from, inline.to);
      return;
    }
    if (name === 'Link') {
      const [open, close] = node.getChildren('LinkMark');
      if (!open || !close || doc.sliceString(open.from, open.to) !== '[') return;
      mark(open.to, close.from, 'cm-lp-link');
      // An empty label would make the whole link invisible.
      if (!touches(from, to) && close.from > open.to) { hide(open.from, open.to); hide(close.from, to); }
      return;
    }
    if (name === 'Autolink') {
      mark(from, to, 'cm-lp-link');
      if (!touches(from, to)) for (const linkMark of node.getChildren('LinkMark')) hide(linkMark.from, linkMark.to);
      return false;
    }
    if (name === 'URL' && !['Link', 'Image', 'Autolink', 'LinkReference'].includes(node.parent?.name)) {
      mark(from, to, 'cm-lp-link');
      return;
    }
    if (name === 'Blockquote') { lines(from, to, 'cm-lp-quote'); return; }
    if (name === 'QuoteMark') {
      if (!linesTouch(from, to)) hide(from, to + (isSpace(to) ? 1 : 0));
      return;
    }
    if (name === 'ListMark') {
      if (linesTouch(from, to)) return;
      const task = node.parent?.getChild('Task')?.getChild('TaskMarker');
      if (task && doc.lineAt(task.from).number === doc.lineAt(from).number) hide(from, task.from);
      else if (node.parent?.parent?.name === 'BulletList') decorations.push(bullet.range(from, to));
      return;
    }
    if (name === 'TaskMarker') {
      if (!linesTouch(from, to)) {
        const checked = doc.sliceString(from + 1, from + 2) !== ' ';
        decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to));
      }
      return;
    }
    if (name === 'HorizontalRule') {
      if (!linesTouch(from, to)) decorations.push(rule.range(from, to));
      return false;
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      lines(from, to, 'cm-lp-codeblock');
      if (name === 'FencedCode') {
        for (const fence of node.getChildren('CodeMark')) lines(fence.from, fence.to, 'cm-lp-fence');
      }
      return false;
    }
    if (name === 'Table') {
      const tableFrom = doc.lineAt(from).from;
      const tableTo = doc.lineAt(to).to;
      if (render && !touches(tableFrom, tableTo)) {
        decorations.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(tableFrom, tableTo), render), block: true }).range(tableFrom, tableTo));
      } else lines(from, to, 'cm-lp-source');
      return false;
    }
    if (['HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'LinkReference'].includes(name)) {
      lines(from, to, 'cm-lp-source');
      return false;
    }
  } });
  return Decoration.set(decorations, true);
}

export function livePreview({ render } = {}) {
  const field = StateField.define({
    create: (state) => build(state, render),
    update(decorations, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, render);
      return decorations;
    },
    provide: (value) => EditorView.decorations.from(value),
  });
  return [field, EditorView.editorAttributes.of({ class: 'cm-live' })];
}
