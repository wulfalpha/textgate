import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditorView } from '@codemirror/view';
import { installDom, closeDom } from './test-dom.js';
import { documentFormat, encodeDocument } from './document-format.js';

test('desktop change handling reloads clean tabs, protects dirty tabs and keeps missing-file text', async (t) => {
  const dom = installDom(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  t.after(() => closeDom(dom));
  const { addTab, updateDiskChanges, flushDetails } = await import('./main.js');
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  const $ = (id) => document.getElementById(id);
  let disk = '\ufeffoutside\r\nsecond line', kept = 0;
  const file = { id: async () => 17, read: async () => new TextEncoder().encode(disk),
    remember: async () => { kept++; }, close: async () => {} };
  const tab = addTab({ text: 'original', path: '/notes.md', file });
  view.dispatch({ selection: { anchor: 6 } });
  await updateDiskChanges([{ document: 17, changed: true, missing: false, error: null }]);
  assert.equal(view.state.doc.toString(), 'outside\nsecond line');
  assert.equal(view.state.selection.main.head, 6);
  assert.equal(encodeDocument(view.state.doc.toString(), view.state.field(documentFormat)), disk);
  assert.equal(kept, 1);
  assert.equal($('dirty').textContent, '');
  assert.equal($('disk-warning').hidden, true);

  view.dispatch({ changes: { from: 0, insert: 'my edits ' } });
  disk = 'a different disk version';
  await updateDiskChanges([{ document: 17, changed: true, missing: false, error: null }]);
  assert.equal(view.state.doc.toString(), 'my edits outside\nsecond line');
  assert.equal(kept, 1);
  assert.match($('disk-warning-text').textContent, /changed outside/);
  assert.equal($('reload-disk').hidden, false);

  const other = addTab({ text: 'clean second tab', path: '/other.md', file: {
    id: async () => 18, read: async () => new TextEncoder().encode('new inactive bytes'), remember: async () => {}, close: async () => {},
  } });
  addTab({ text: 'focus remains here' });
  const selected = document.activeElement;
  await updateDiskChanges([{ document: 18, changed: true, missing: false, error: null }]);
  assert.equal(other.state.doc.toString(), 'new inactive bytes');
  assert.equal(view.state.doc.toString(), 'focus remains here');
  assert.equal(document.activeElement, selected);

  await updateDiskChanges([{ document: 17, changed: true, missing: true, error: null }]);
  assert.equal(tab.missing, true);
  assert.equal(tab.state.doc.toString(), 'my edits outside\nsecond line');
  await flushDetails();
});
