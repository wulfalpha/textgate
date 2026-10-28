import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { relativeLineNumbers } from './line-numbers.js';

installDom();
const doc = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
function make(anchor) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [basicSetup, relativeLineNumbers()] }),
  });
}
// Visible numbers, skipping the hidden spacer that sizes the gutter.
const numbers = (view) => [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
  .filter((element) => element.style.visibility !== 'hidden').map((element) => element.textContent);
const currentNumber = (view) => view.dom.querySelector('.cm-lineNumbers .cm-lineNumber-current')?.textContent;

test('the cursor line shows its number and other lines their distance', () => {
  const view = make(doc.indexOf('line 4'));
  assert.deepEqual(numbers(view), ['3', '2', '1', '4', '1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(currentNumber(view), '4');
  assert.ok(view.dom.classList.contains('cm-relative-numbers'));
  view.destroy();
});

test('numbers follow the cursor to another line, and edits keep them correct', () => {
  const view = make(0);
  assert.deepEqual(numbers(view).slice(0, 3), ['1', '1', '2']);
  view.dispatch({ selection: { anchor: doc.indexOf('line 10') } });
  assert.deepEqual(numbers(view).slice(7, 12), ['2', '1', '10', '1', '2']);
  assert.equal(currentNumber(view), '10');
  // A new line above the cursor moves it to line 11.
  view.dispatch({ changes: { from: 0, insert: 'new\n' } });
  assert.equal(currentNumber(view), '11');
  assert.deepEqual(numbers(view).slice(0, 2), ['10', '9']);
  view.destroy();
});

test('the gutter is sized for the largest real line number', () => {
  const view = make(0);
  const spacer = [...view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    .find((element) => element.style.visibility === 'hidden');
  assert.equal(spacer.textContent, '99');
  view.destroy();
});
