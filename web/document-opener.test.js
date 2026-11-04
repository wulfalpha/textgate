import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentOpener } from './document-opener.js';
const bytes = (value) => new TextEncoder().encode(value);

// A fake store: each handle records its calls; `read` decides what the file holds.
function setup({ read = async () => bytes('new'), remember = async () => {}, open = {}, holders = {} } = {}) {
  const events = [];
  const handles = [];
  const documents = { create() {
    const handle = {
      n: handles.length + 1,
      read: (path, options) => { events.push(['read', handle.n, path, options]); return read(path, options); },
      remember: async (path) => { events.push(['keep', handle.n, path]); await remember(); },
      close: async () => { events.push(['close', handle.n]); },
    };
    handles.push(handle);
    return handle;
  } };
  const opener = createDocumentOpener({
    documents,
    existing: (path) => open[path] ?? null,
    holder: async (id) => holders[id] ?? null,
    show: (tab) => events.push(['show', tab]),
    place: (opened) => { events.push(['place', opened.path, opened.text, opened.format, opened.file.n]); return { name: opened.path }; },
  });
  return { open: opener, events };
}

test('a file opens in its own document and is kept before it is shown', async () => {
  const env = setup({ read: async () => bytes('﻿new\r\n') });
  const result = await env.open('/a', { create: true });
  assert.deepEqual(result.tab, { name: '/a' });
  assert.equal(result.already, false);
  assert.deepEqual(env.events, [
    ['read', 1, '/a', { create: true }],
    ['keep', 1, '/a'],
    ['place', '/a', 'new\n', { bom: true, lineEnding: '\r\n', mixed: false, endings: null }, 1],
  ]);
});

test('a path that is already open switches to its tab without reading', async () => {
  const tab = { name: 'open' };
  const env = setup({ open: { '/a': tab }, read: () => assert.fail('must not read') });
  assert.deepEqual(await env.open('/a'), { tab, already: true });
  assert.deepEqual(env.events, [['show', tab]]);
});

test('the same file under another path switches to the tab Rust names', async () => {
  const tab = { name: 'linked' };
  const env = setup({ holders: { 4: tab }, read: async () => { throw { kind: 'alreadyOpen', document: 4, message: 'open elsewhere' }; } });
  assert.deepEqual(await env.open('/link/a'), { tab, already: true });
  assert.deepEqual(env.events.slice(1), [['close', 1], ['show', tab]]);
});

test('read, decoding and keep failures release the new document and show nothing', async () => {
  const failures = [
    { read: async () => { throw new Error('Unreadable'); } },
    { read: async () => new Uint8Array([0xff]) },
    { remember: async () => { throw { kind: 'alreadyOpen', document: 9, message: 'raced' }; } },
  ];
  for (const options of failures) {
    const env = setup(options);
    await assert.rejects(env.open('/a'));
    assert.deepEqual(env.events.at(-1), ['close', 1]);
    assert.ok(!env.events.some(([kind]) => kind === 'place' || kind === 'show'));
  }
});
