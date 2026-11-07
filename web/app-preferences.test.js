import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditorView } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';
import { installDom, closeDom } from './test-dom.js';

test('saved Vim and line-ending choices are applied when the app starts and persist when turned off', async (t) => {
  const dom = installDom(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  t.after(() => closeDom(dom));
  const storage = window.localStorage;
  storage.setItem('textgate.vim', 'on');
  storage.setItem('textgate.show-line-endings', 'on');
  const { flushDetails } = await import('./main.js');
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  const $ = (id) => document.getElementById(id);
  const original = view.state.doc.toString();
  assert.equal($('vim').getAttribute('aria-pressed'), 'true');
  assert.ok(getCM(view)?.state.vim);
  assert.match($('editor-status').textContent, /Vim NORMAL/);
  assert.equal($('show-line-endings').getAttribute('aria-pressed'), 'true');
  assert.ok(view.dom.querySelector('.cm-line-ending'));
  $('mode-source').click();
  assert.ok(view.dom.querySelector('.cm-line-ending'));
  $('show-line-endings').click();
  assert.equal(view.dom.querySelector('.cm-line-ending'), null);
  assert.equal(storage.getItem('textgate.show-line-endings'), 'off');
  $('vim').click();
  assert.equal($('vim').getAttribute('aria-pressed'), 'false');
  assert.equal(storage.getItem('textgate.vim'), 'off');
  assert.equal(view.state.doc.toString(), original);
  assert.equal($('dirty').textContent, '');
  // A newly created tab also uses the global choices, rather than an older
  // state captured before the settings changed.
  $('new').click();
  $('show-line-endings').click();
  view.dispatch({ changes: { from: 0, insert: 'first\nsecond' } });
  assert.equal(view.dom.querySelectorAll('.cm-line-ending').length, 1);
  document.querySelector('#tabbar [role="tab"]').click();
  assert.equal(view.state.doc.toString(), original);
  assert.ok(view.dom.querySelector('.cm-line-ending'), 'existing tabs receive the current setting');
  await flushDetails();
  view.destroy();
});
