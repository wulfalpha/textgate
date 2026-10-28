import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from './document-store.js';

// Baseline and conflict checks run in Rust (src/documents.rs); these tests
// cover the commands and save modes the webview sends.
function setup(results, confirmOverwrite = async () => false) {
  const calls = [];
  const store = createDocumentStore({ confirmOverwrite, invoke: async (command, args) => {
    calls.push({ command, ...args });
    const result = results.shift();
    if (result instanceof Error || result?.kind) throw result;
    return result;
  } });
  return { store, calls };
}
const modes = (calls) => calls.filter((call) => call.command === 'save_document').map((call) => call.mode);

test('open returns raw bytes and keeps the document only when asked', async () => {
  const env = setup([new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer, undefined]);
  assert.deepEqual([...await env.store.read('/a')], [0xef, 0xbb, 0xbf, 0x61]);
  await env.store.remember('/a');
  assert.deepEqual(env.calls.map((call) => call.command), ['open_document', 'keep_document']);
});

test('saves check the baseline; dialog-chosen paths replace', async () => {
  const env = setup([undefined, undefined]);
  assert.equal(await env.store.save('/a', 'one'), true);
  assert.equal(await env.store.save('/b', 'two', { chosen: true }), true);
  assert.deepEqual(modes(env.calls), ['save', 'replace']);
  assert.equal(env.calls[0].contents, 'one');
  assert.equal(env.calls[0].expected, undefined, 'no disk bytes are sent');
});

test('conflicts ask first; cancelling leaves the file alone', async () => {
  const prompts = [];
  const env = setup([{ kind: 'conflict', missing: false }], async (...args) => { prompts.push(args); return false; });
  assert.equal(await env.store.save('/a', 'editor'), false);
  assert.deepEqual(prompts, [['/a', false]]);
  assert.deepEqual(modes(env.calls), ['save']);
});

test('approval overwrites once, and a newer outside edit asks again', async () => {
  const prompts = [];
  const env = setup(
    [{ kind: 'conflict', missing: true }, { kind: 'conflict', missing: false }, undefined],
    async (...args) => { prompts.push(args); return true; },
  );
  assert.equal(await env.store.save('/a', 'editor'), true);
  assert.deepEqual(prompts, [['/a', true], ['/a', false]]);
  assert.deepEqual(modes(env.calls), ['save', 'overwrite', 'overwrite']);
});

test('I/O failures propagate without prompting', async () => {
  const env = setup([{ kind: 'io', message: 'Disk full' }], () => assert.fail());
  await assert.rejects(env.store.save('/a', 'new'), { kind: 'io', message: 'Disk full' });
});
