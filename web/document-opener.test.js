import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { createDocumentOpener } from './document-opener.js';
const text = (value) => Text.of(value.split('\n'));
const bytes = (value) => new TextEncoder().encode(value);
function setup({ read = async () => bytes('new'), confirm = async () => true, remember = async () => {} } = {}) {
  let doc = text('old');
  const events = [];
  const open = createDocumentOpener({
    documents: { read, remember: async (path) => { events.push(['keep', path]); await remember(); } },
    snapshot: () => doc, canDiscard: confirm,
    replace: (source, path, format) => { events.push(['replace', path, format]); doc = text(source); },
    opened: (path) => events.push(['opened', path]),
  });
  return { open, events, edit: (value) => { doc = text(value); }, current: () => doc };
}

test('cancelled open never reads, replaces or changes the saved baseline', async () => {
  const env = setup({ confirm: async () => false, read: () => assert.fail() });
  assert.equal(await env.open('/a'), false);
  assert.deepEqual(env.events, []);
  assert.equal(env.current().toString(), 'old');
});

test('read and UTF-8 errors preserve the original document', async () => {
  for (const read of [async () => { throw new Error('Unreadable'); }, async () => new Uint8Array([0xff])]) {
    const env = setup({ read });
    await assert.rejects(env.open('/a'));
    assert.deepEqual(env.events, []);
    assert.equal(env.current().toString(), 'old');
  }
});

test('edits during file read require fresh discard approval', async () => {
  let finishRead, prompts = 0;
  const env = setup({ read: () => new Promise((resolve) => { finishRead = resolve; }), confirm: async () => ++prompts === 1 });
  const opening = env.open('/a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  env.edit('keep these newer edits');
  finishRead(bytes('new'));
  assert.equal(await opening, false);
  assert.equal(prompts, 2);
  assert.equal(env.current().toString(), 'keep these newer edits');
  assert.deepEqual(env.events, []);
});

test('approval cannot discard edits made while the confirmation itself is open', async () => {
  let prompts = 0;
  const env = setup({ confirm: async () => {
    if (++prompts === 1) { env.edit('changed during confirmation'); return true; }
    return false;
  } });
  assert.equal(await env.open('/a'), false);
  assert.equal(prompts, 2);
  assert.equal(env.current().toString(), 'changed during confirmation');
});

test('BOM/CRLF are decoded and later edits survive the baseline acknowledgement', async () => {
  let finishKeep;
  const env = setup({ read: async () => bytes('\ufeffnew\r\n'), remember: () => new Promise((resolve) => { finishKeep = resolve; }) });
  const opening = env.open('/a', { create: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.current().toString(), 'new\n');
  assert.deepEqual(env.events[0], ['replace', '/a', { bom: true, lineEnding: '\r\n', mixed: false }]);
  env.edit('edits to the new file');
  finishKeep();
  assert.equal(await opening, true);
  assert.equal(env.current().toString(), 'edits to the new file');
});
