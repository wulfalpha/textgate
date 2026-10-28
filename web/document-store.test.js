import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from './document-store.js';

const bytes = (text) => Array.from(new TextEncoder().encode(text));
function setup(initial, confirmOverwrite = async () => false) {
  let disk = initial;
  const calls = [];
  const store = createDocumentStore({ confirmOverwrite, invoke: async (command, args) => {
    calls.push({ command, ...args });
    if (command === 'document_snapshot') return disk;
    if (JSON.stringify(args.expected) !== JSON.stringify(disk)) throw { kind: 'conflict' };
    disk = bytes(args.contents);
  } });
  return { store, calls, disk: () => disk, change: (value) => { disk = value; } };
}

test('open and save retain the exact BOM/CRLF baseline and advance it only on success', async () => {
  const original = bytes('\ufeffa\r\nb\n');
  const env = setup(original);
  env.store.remember('/a', await env.store.read('/a'));
  assert.equal(await env.store.save('/a', '\ufeffedited\r\n'), true);
  assert.deepEqual(env.calls[1].expected, original);
  assert.equal(await env.store.save('/a', 'next'), true);
  assert.deepEqual(env.calls[2].expected, bytes('\ufeffedited\r\n'));
});

test('cancel protects external bytes and retains the original baseline', async () => {
  const env = setup(bytes('old'));
  env.store.remember('/a', await env.store.read('/a'));
  env.change(bytes('external'));
  assert.equal(await env.store.save('/a', 'editor'), false);
  assert.deepEqual(env.disk(), bytes('external'));
  env.change(bytes('old'));
  assert.equal(await env.store.save('/a', 'editor'), true);
});

test('overwrite approval never overwrites a newer unapproved disk version', async () => {
  let prompts = 0;
  const env = setup(bytes('old'), async () => {
    prompts++;
    if (prompts === 1) { env.change(bytes('newer')); return true; }
    return false;
  });
  env.store.remember('/a', await env.store.read('/a'));
  env.change(bytes('external'));
  assert.equal(await env.store.save('/a', 'editor'), false);
  assert.equal(prompts, 2);
  assert.deepEqual(env.disk(), bytes('newer'));
});

test('deleted files need approval before recreation; Save As snapshots its destination', async () => {
  const env = setup(bytes('old'), async (_path, missing) => { assert.equal(missing, true); return true; });
  env.store.remember('/a', await env.store.read('/a'));
  env.change(null);
  assert.equal(await env.store.save('/a', 'restored'), true);
  env.change(bytes('destination'));
  assert.equal(await env.store.save('/b', 'copy'), true);
  assert.deepEqual(env.calls.at(-1).expected, bytes('destination'));
});

test('I/O failures propagate without advancing the saved baseline', async () => {
  let fail = true;
  const expected = bytes('old');
  const store = createDocumentStore({ confirmOverwrite: () => assert.fail(), invoke: async (_command, args) => {
    assert.deepEqual(args.expected, expected);
    if (fail) throw { kind: 'io', message: 'Disk full' };
  } });
  store.remember('/a', expected);
  await assert.rejects(store.save('/a', 'new'), { kind: 'io', message: 'Disk full' });
  fail = false;
  assert.equal(await store.save('/a', 'new'), true);
});
