import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { cursorScale, fullHeightVimCursor, restoreFullCursor, widenBlankCursor } from './vim-cursor.js';

installDom();

function cursor({ top, height, color }) {
  const element = document.createElement('div');
  element.className = 'cm-fat-cursor cm-cursor-primary';
  Object.assign(element.style, { top: `${top}px`, height: `${height}px`, lineHeight: `${height}px`, color });
  element.textContent = 'a';
  return element;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a half-height pending cursor regains its full height and letter', () => {
  // The plugin drew a 20px character at top 100 as its bottom half.
  const element = cursor({ top: 110, height: 10, color: 'transparent' });
  assert.equal(restoreFullCursor(element, 0.5), true);
  assert.equal(element.style.top, '100px');
  assert.equal(element.style.height, '20px');
  assert.equal(element.style.lineHeight, '20px');
  assert.equal(element.style.color, '');
});

test('a Replace-mode sliver regains its full height', () => {
  const element = cursor({ top: 116, height: 4, color: 'transparent' });
  assert.equal(restoreFullCursor(element, 0.2), true);
  assert.equal(element.style.top, '100px');
  assert.equal(element.style.height, '20px');
});

test('full cursors are left alone, so corrections never compound', () => {
  const element = cursor({ top: 100, height: 20, color: 'rgb(0, 0, 0)' });
  assert.equal(restoreFullCursor(element, 0.5), false);
  assert.equal(element.style.height, '20px');
  const fixed = cursor({ top: 110, height: 10, color: 'transparent' });
  restoreFullCursor(fixed, 0.5);
  assert.equal(restoreFullCursor(fixed, 0.5), false);
  assert.equal(fixed.style.height, '20px');
});

test('the scale follows the Vim state', () => {
  assert.equal(cursorScale(null), 1);
  assert.equal(cursorScale({ state: { vim: { status: '' } } }), 1);
  assert.equal(cursorScale({ state: { vim: { status: 'd' } } }), 0.5);
  assert.equal(cursorScale({ state: { vim: { status: '' }, overwrite: true } }), 0.2);
});

// The plugin records pending keys in `status` from its DOM key handler, which
// Vim.handleKey bypasses, so tests set it as that handler would.
const press = (cm, key) => { cm.state.vim.status = (cm.state.vim.status || '') + key; Vim.handleKey(cm, key); };

test('Replace mode reports the plugin scale in a real editor', () => {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'hello world', extensions: [vim(), fullHeightVimCursor] }),
  });
  const cm = getCM(view);
  assert.equal(cursorScale(cm), 1);
  Vim.handleKey(cm, 'R');
  assert.equal(cursorScale(cm), 0.2);
  view.destroy();
});

test('cursors the Vim plugin redraws are corrected in its layer', async () => {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'hello world', extensions: [vim(), fullHeightVimCursor] }),
  });
  const cm = getCM(view);
  const layer = view.scrollDOM.querySelector('.cm-vimCursorLayer');
  assert.ok(layer, 'the Vim plugin draws its own cursor layer');
  press(cm, 'd');
  assert.equal(cursorScale(cm), 0.5);
  // Stand in for the plugin's redraw, which jsdom cannot measure.
  layer.replaceChildren(cursor({ top: 110, height: 10, color: 'transparent' }));
  await flush();
  const element = layer.querySelector('.cm-fat-cursor');
  assert.equal(element.style.height, '20px');
  assert.equal(element.style.top, '100px');
  // A later in-place adjustment is corrected again.
  Object.assign(element.style, { top: '130px', height: '10px', color: 'transparent' });
  await flush();
  assert.equal(element.style.height, '20px');
  assert.equal(element.style.top, '120px');
  view.destroy();
});

test('a cursor on a line end is widened; one on a letter keeps its width', () => {
  const element = cursor({ top: 0, height: 20, color: 'rgb(0, 0, 0)' });
  element.textContent = '\u00a0';
  assert.equal(widenBlankCursor(element), true);
  assert.equal(element.style.minWidth, '0.6em');
  assert.equal(widenBlankCursor(element), false);
  // The plugin reuses the element when the cursor moves onto a letter.
  element.textContent = 'i';
  assert.equal(widenBlankCursor(element), true);
  assert.equal(element.style.minWidth, '');
});
