import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { textDirection } from './text-direction.js';

installDom();

test('only lines with right-to-left text get an automatic direction, and edits update it', () => {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'English\nمرحبا بالعالم\nשלום\nmixed שלום text', extensions: [textDirection()] }),
  });
  const dirs = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.getAttribute('dir'));
  assert.deepEqual(dirs(), [null, 'auto', 'auto', 'auto']);
  view.dispatch({ changes: { from: 0, to: 7, insert: 'עברית' } });
  assert.deepEqual(dirs(), ['auto', 'auto', 'auto', 'auto']);
  view.destroy();
});
