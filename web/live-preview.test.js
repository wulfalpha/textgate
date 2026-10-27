import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { livePreview } from './live-preview.js';

installDom();
const render = async (source) => {
  const fragment = document.createDocumentFragment();
  const table = document.createElement('table');
  table.textContent = `rendered:${source.length}`;
  fragment.append(table);
  return fragment;
};
function make(doc, anchor = doc.length) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), livePreview({ render })] }),
  });
}
const shown = (view) => view.contentDOM.textContent;

const sample = '# Title\n\n**bold** and [link](https://example.com)\n\n- item\n- [ ] task\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend';

test('markup is hidden away from the cursor and the document is untouched', async () => {
  const view = make(sample);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(view.dom.classList.contains('cm-live'));
  const text = shown(view);
  for (const markup of ['# Title', '**', '](https://example.com)', '- item', '> quote', '| a |']) assert.ok(!text.includes(markup), markup);
  for (const content of ['Title', 'bold', 'link', 'item', 'task', 'quote']) assert.ok(text.includes(content), content);
  assert.ok(view.dom.querySelector('.cm-lp-h1'));
  assert.ok(view.dom.querySelector('.cm-lp-bullet'));
  assert.ok(view.dom.querySelector('input.cm-lp-task'));
  assert.match(view.dom.querySelector('.cm-lp-table').textContent, /^rendered:/);
  assert.equal(view.state.doc.toString(), sample);
  view.destroy();
});

test('markup is revealed where the cursor is', () => {
  const view = make(sample, sample.indexOf('bold'));
  assert.ok(shown(view).includes('**bold**'));
  assert.ok(!shown(view).includes('# Title'));
  view.dispatch({ selection: { anchor: 2 } });
  assert.ok(shown(view).includes('# Title'));
  view.dispatch({ selection: { anchor: sample.indexOf('| 1') } });
  assert.ok(shown(view).includes('| a | b |'));
  view.destroy();
});

test('clicking a task checkbox toggles one character', () => {
  const view = make(sample);
  const box = view.dom.querySelector('input.cm-lp-task');
  box.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(view.state.doc.toString(), sample.replace('- [ ] task', '- [x] task'));
  view.destroy();
});

test('front matter and setext headings stay intact', () => {
  const doc = '---\ntitle: x\n---\n\nHeading\n=======\n\nend';
  const view = make(doc);
  const text = shown(view);
  assert.ok(text.includes('title: x'));
  assert.ok(text.includes('---'));
  assert.ok(!text.includes('======='));
  assert.equal(view.state.doc.toString(), doc);
  view.destroy();
});
