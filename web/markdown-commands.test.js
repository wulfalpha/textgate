import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as format from './markdown-commands.js';

installDom();
function make(doc, anchor = 0, head = anchor) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown({ base: markdownLanguage })] }),
  });
}
const text = (view) => view.state.doc.toString();

test('inline formatting wraps and unwraps using the existing spelling', () => {
  const view = make('Hello world', 0, 5);
  format.toggleInline(view, 'bold');
  assert.equal(text(view), '**Hello** world');
  format.toggleInline(view, 'bold');
  assert.equal(text(view), 'Hello world');
  view.setState(EditorState.create({ doc: 'a __kept__ b', selection: { anchor: 5 }, extensions: [markdown({ base: markdownLanguage })] }));
  format.toggleInline(view, 'bold');
  assert.equal(text(view), 'a kept b');
  view.setState(EditorState.create({ doc: 'x', selection: { anchor: 1 }, extensions: [markdown({ base: markdownLanguage })] }));
  format.toggleInline(view, 'code');
  assert.equal(text(view), 'x``');
  assert.equal(view.state.selection.main.head, 2);
  view.destroy();
});

test('headings change only the line prefix', () => {
  const view = make('## Title *kept*\n', 3);
  format.setHeading(view, 3);
  assert.equal(text(view), '### Title *kept*\n');
  format.setHeading(view, 0);
  assert.equal(text(view), 'Title *kept*\n');
  view.destroy();
});

test('lists, tasks and quotes toggle per line without touching content', () => {
  const view = make('one _a_\ntwo\n', 0, 10);
  format.toggleList(view, 'bullet');
  assert.equal(text(view), '- one _a_\n- two\n');
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  format.toggleList(view, 'ordered');
  assert.equal(text(view), '1. one _a_\n2. two\n');
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  format.toggleList(view, 'task');
  assert.equal(text(view), '- [ ] one _a_\n- [ ] two\n');
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  format.toggleList(view, 'task');
  assert.equal(text(view), 'one _a_\ntwo\n');
  view.dispatch({ selection: { anchor: 0, head: 3 } });
  format.toggleQuote(view);
  assert.equal(text(view), '> one _a_\ntwo\n');
  format.toggleQuote(view);
  assert.equal(text(view), 'one _a_\ntwo\n');
  view.destroy();
});

test('code blocks wrap lines and unwrap fences', () => {
  const view = make('let x;\n', 0);
  format.toggleCodeBlock(view);
  assert.equal(text(view), '```\nlet x;\n```\n');
  view.dispatch({ selection: { anchor: 5 } });
  format.toggleCodeBlock(view);
  assert.equal(text(view), 'let x;\n');
  view.destroy();
});

test('links are inserted, edited in place and removed', () => {
  const view = make('see docs here', 4, 8);
  format.applyLink(view, 'https://a.example');
  assert.equal(text(view), 'see [docs](https://a.example) here');
  view.dispatch({ selection: { anchor: 6 } });
  assert.equal(format.linkAt(view.state).href, 'https://a.example');
  assert.ok(format.activeFormats(view.state).active.has('link'));
  format.applyLink(view, './my file.md');
  assert.equal(text(view), 'see [docs](<./my file.md>) here');
  format.removeLink(view);
  assert.equal(text(view), 'see docs here');
  view.destroy();
});

test('tables are inserted after the current line with the first header selected', () => {
  const view = make('Intro', 2);
  format.insertTable(view);
  assert.equal(text(view), 'Intro\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), 'Column 1');
  view.destroy();
});

test('active formats reflect the cursor position', () => {
  const view = make('## Head\n\n- [ ] **task**\n\n1. one\n', 20);
  const { active, heading } = format.activeFormats(view.state);
  assert.ok(active.has('bold') && active.has('taskList'));
  assert.equal(heading, 0);
  view.dispatch({ selection: { anchor: 4 } });
  assert.equal(format.activeFormats(view.state).heading, 2);
  view.dispatch({ selection: { anchor: view.state.doc.length - 2 } });
  assert.ok(format.activeFormats(view.state).active.has('orderedList'));
  view.destroy();
});
