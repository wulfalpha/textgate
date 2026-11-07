import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { askRenamePreview, renameTransaction } from './rename-dialog.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const setup = () => {
  const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  const document = dom.window.document, get = (id) => document.getElementById(id), dialog = get('rename-preview-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  return { dom, document, get };
};
const preview = { token: '1', from: '/notes/Old.md', to: '/notes/New.md', issues: [], retry: false,
  files: [{ label: 'source.md', path: '/notes/source.md', editor: true, edits: [{ line: 2, context: '[[Old]]', after_context: '[[New|Old]]' }] }] };
const result = { token: '1', rename_done: true, written: 1, pending: 0, error: null, written_files: ['closed.md'], pending_files: [], editor_files: ['source.md'] };

test('rename patches map selections, preserve prior history and undo as one editor transaction', () => {
  let state = EditorState.create({ doc: '[[Old]] and [[Old]] tail', extensions: [history()] });
  state = state.update({ changes: { from: 0, insert: 'my draft ' }, selection: { anchor: 31 }, userEvent: 'input' }).state;
  const original = state.doc.toString(), selected = state.selection.main.head;
  const edits = [...original.matchAll(/Old/g)].map((match) => ({ from: match.index, to: match.index + 3, before: 'Old', insert: 'New title|Old' }));
  state = renameTransaction(state, edits).state;
  assert.match(state.doc.toString(), /my draft \[\[New title\|Old\]\]/);
  assert.equal(state.selection.main.head, selected + 2 * ('New title|Old'.length - 3));
  const dispatch = (transaction) => { state = transaction.state; };
  assert.ok(undo({ state, dispatch })); assert.equal(state.doc.toString(), original);
  assert.ok(redo({ state, dispatch })); assert.match(state.doc.toString(), /New title/);
  assert.throws(() => renameTransaction(state, edits), /source changed/);
});

test('Cancel performs no mutation and unsafe previews disable only bulk updates', async () => {
  const { dom, document, get } = setup(); let applied = 0;
  const pending = askRenamePreview(document, { ...preview, issues: ['Unreadable note'] }, { apply: () => { applied++; }, acknowledge() {}, review() {} });
  assert.equal(get('rename-update').disabled, true); assert.equal(get('rename-only').disabled, false);
  assert.equal(document.activeElement, get('rename-preview-cancel'));
  assert.match(get('rename-preview-changes').textContent, /Editor only/);
  get('rename-preview-cancel').click(); assert.equal(await pending, null); assert.equal(applied, 0);
  dom.window.close();
});

test('Rename Only is explicit and completed results are acknowledged before closing', async () => {
  const { dom, document, get } = setup(); const calls = [];
  const pending = askRenamePreview(document, preview, {
    apply: async (_plan, update) => { calls.push(update); return { ...result, editor_files: [], written: 0, written_files: [] }; },
    acknowledge: async (value) => { calls.push(value.token); }, review() {},
  });
  get('rename-only').click(); await tick();
  assert.equal(get('rename-preview-cancel').textContent, 'Acknowledge and Close');
  get('rename-preview-cancel').click(); await pending;
  assert.deepEqual(calls, [false, '1']); dom.window.close();
});

test('Stop is cooperative and retry requires a fresh preview without acknowledging cancelled review', async () => {
  const { dom, document, get } = setup(); let complete; let stopped; let acknowledgements = 0;
  const pending = askRenamePreview(document, preview, {
    apply: async (_plan, _update, control) => { stopped = control.stopped; return new Promise((resolve) => { complete = resolve; }); },
    acknowledge() { acknowledgements++; }, review: async () => ({ ...preview, token: '2', retry: true }),
  });
  get('rename-update').click(); get('rename-stop').click(); assert.equal(stopped(), true);
  complete({ ...result, pending: 1, error: 'Stopped', pending_files: ['pending.md'] }); await tick();
  assert.match(get('rename-preview-changes').textContent, /pending.md/);
  get('rename-review').click(); await tick();
  assert.match(get('rename-preview-title').textContent, /remaining/);
  get('rename-preview-cancel').click(); assert.equal(await pending, null);
  assert.equal(acknowledgements, 0); dom.window.close();
});

test('acknowledgement cannot overlap and leave a late checkpoint after the dialog closes', async () => {
  const { dom, document, get } = setup(); let acknowledged = 0, release;
  const pending = askRenamePreview(document, preview, {
    apply: async () => result,
    acknowledge: async () => { acknowledged++; await new Promise((resolve) => { release = resolve; }); }, review() {},
  });
  get('rename-update').click(); await tick();
  get('rename-preview-cancel').click(); get('rename-preview-cancel').click(); await tick();
  assert.equal(acknowledged, 1); assert.equal(get('rename-preview-cancel').disabled, true);
  release(); await pending; dom.window.close();
});
