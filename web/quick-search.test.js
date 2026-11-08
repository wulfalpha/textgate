import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { askQuickSearch } from './quick-search.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
function setup() {
  const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  const document = dom.window.document;
  const dialog = document.getElementById('quick-search-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  return { dom, document, get: (id) => document.getElementById(id),
    key: (value) => document.getElementById('quick-search-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) };
}
const entries = [{ path: '/notes/a.md', label: 'a.md' }, { path: '/notes/sub/a.md', label: 'sub/a.md' }];

test('quick search supports keyboard selection, folder context and safe result text', async () => {
  const { dom, document, get, key } = setup();
  const result = askQuickSearch(document, { query: async () => ({ entries, warnings: [] }), delay: 0, interval: 100000 });
  await tick();
  assert.equal(document.activeElement, get('quick-search-input'));
  assert.match(get('quick-search-results').textContent, /sub\/a.md/);
  key('ArrowDown');
  assert.equal(get('quick-search-input').getAttribute('aria-activedescendant'), 'quick-note-1');
  key('Enter'); assert.deepEqual(await result, entries[1]);
  assert.equal(get('quick-search-dialog').open, false); dom.window.close();
});

test('changed queries suppress old results and opening while busy; Escape cancels', async () => {
  const { dom, document, get, key } = setup(); let release; const calls = [];
  const result = askQuickSearch(document, { query: (text) => { calls.push(text); return new Promise((resolve) => { release = resolve; }); }, delay: 0, interval: 100000 });
  await tick();
  get('quick-search-input').value = 'new'; get('quick-search-input').dispatchEvent(new dom.window.Event('input'));
  release({ entries, warnings: [] }); await tick();
  assert.equal(get('quick-search-results').children.length, 0);
  key('Enter'); assert.equal(get('quick-search-dialog').open, true);
  assert.deepEqual(calls, ['', 'new']);
  key('Escape'); assert.equal(await result, null);
  release({ entries, warnings: [] }); await tick();
  assert.equal(get('quick-search-results').children.length, 0); dom.window.close();
});

test('partial results, errors and refresh are explicit and cancellation never selects a note', async () => {
  const { dom, document, get } = setup(); let count = 0;
  const result = askQuickSearch(document, { query: async () => {
    if (++count === 1) throw new Error('Folder changed');
    return { entries: [{ path: '/notes/<img>.md', label: '<img>.md' }], warnings: ['Scan limit'] };
  }, delay: 0, interval: 100000 });
  await tick(); assert.match(get('quick-search-status').textContent, /Folder changed/);
  get('quick-search-refresh').click(); await tick();
  assert.match(get('quick-search-warning').textContent, /Partial results.*Scan limit/);
  assert.equal(get('quick-search-results').querySelector('img'), null);
  get('quick-search-cancel').click(); assert.equal(await result, null); dom.window.close();
});
