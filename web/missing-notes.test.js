import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { askMissingNote } from './missing-notes.js';

const setup = () => {
  const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  const document = dom.window.document;
  const dialog = document.getElementById('missing-note-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  return { dom, document, get: (id) => document.getElementById(id) };
};
const proposal = { canId: true, title: 'Next note', path: '/notes/Next note.md' };

test('missing-note confirmation defaults to ID creation but cancellation creates nothing', async () => {
  const { dom, document, get } = setup();
  let calls = 0;
  const result = askMissingNote(document, proposal, () => { calls++; });
  assert.equal(get('missing-note-id').checked, true);
  assert.match(get('missing-note-path').textContent, /source stays unsaved/);
  assert.equal(document.activeElement, get('missing-note-cancel'));
  get('missing-note-cancel').click();
  assert.equal(await result, null);
  assert.equal(calls, 0);
  dom.window.close();
});

test('creation requires submission, supports exact names and keeps errors visible for retry', async () => {
  const { dom, document, get } = setup();
  let calls = 0;
  const result = askMissingNote(document, proposal, async (withId) => {
    assert.equal(withId, false);
    if (++calls === 1) throw new Error('Destination changed');
    return '/notes/Next note.md';
  });
  get('missing-note-id').checked = false;
  get('missing-note-id').dispatchEvent(new dom.window.Event('change'));
  assert.match(get('missing-note-path').textContent, /Keep the link unchanged/);
  const submit = () => get('missing-note-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  submit();
  assert.equal(get('missing-note-cancel').disabled, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(get('missing-note-error').textContent, /Destination changed/);
  assert.equal(get('missing-note-dialog').open, true);
  submit();
  assert.equal(await result, '/notes/Next note.md');
  assert.equal(calls, 2);
  dom.window.close();
});

test('explicit file paths do not offer timestamp naming; Escape cancels', async () => {
  const { dom, document, get } = setup();
  const result = askMissingNote(document, { ...proposal, canId: false }, () => assert.fail('No submission'));
  assert.equal(get('missing-note-choice').hidden, true);
  assert.equal(get('missing-note-id').checked, false);
  get('missing-note-dialog').close();
  assert.equal(await result, null);
  dom.window.close();
});

test('a source outside the workspace still offers ID creation without an unsafe filename choice', async () => {
  const { dom, document, get } = setup();
  const result = askMissingNote(document, { ...proposal, filenameError: 'The source is outside the open folder.' }, async (withId) => {
    assert.equal(withId, true);
    return '/workspace/202611071530 Next note.md';
  });
  assert.equal(get('missing-note-choice').hidden, true);
  assert.match(get('missing-note-description').textContent, /outside/);
  get('missing-note-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(await result, '/workspace/202611071530 Next note.md');
  dom.window.close();
});
