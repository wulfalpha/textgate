import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { defineVimFileCommands } from './vim-commands.js';

installDom();

// One set of definitions, as in the app; each test swaps the behaviour behind it.
let app;
defineVimFileCommands(Vim, {
  run: (action) => app.run(action),
  save: () => app.save(), saveAs: () => app.saveAs(),
  isDirty: () => app.dirty, close: () => app.close(), message: (text) => app.message(text),
});

function setup({ dirty = false, saved = true } = {}) {
  const calls = [];
  const pending = [];
  app = {
    dirty,
    run: (action) => { pending.push(action()); },
    save: async () => { calls.push('save'); return saved; },
    saveAs: async () => { calls.push('saveAs'); return saved; },
    close: async () => { calls.push('close'); },
    message: (text) => calls.push(`message: ${text}`),
  };
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'text', extensions: [vim()] }) });
  const ex = async (input) => { Vim.handleEx(getCM(view), input); await Promise.all(pending); };
  return { calls, ex, done: () => view.destroy() };
}

test(':w and :write save; :w! saves too', async () => {
  for (const input of ['w', 'write', 'w!']) {
    const { calls, ex, done } = setup({ dirty: true });
    await ex(input);
    assert.deepEqual(calls, ['save'], input);
    done();
  }
});

test(':saveas chooses a new file', async () => {
  const { calls, ex, done } = setup();
  await ex('sav');
  assert.deepEqual(calls, ['saveAs']);
  done();
});

test(':wq, :x and :wq! save then close', async () => {
  for (const input of ['wq', 'x', 'xit', 'wq!']) {
    const { calls, ex, done } = setup({ dirty: true });
    await ex(input);
    assert.deepEqual(calls, ['save', 'close'], input);
    done();
  }
});

test(':wq stays open when the save is cancelled or refused', async () => {
  const { calls, ex, done } = setup({ dirty: true, saved: false });
  await ex('wq');
  assert.deepEqual(calls, ['save']);
  done();
});

test(':q closes a clean document', async () => {
  for (const input of ['q', 'quit', 'qa']) {
    const { calls, ex, done } = setup();
    await ex(input);
    assert.deepEqual(calls, ['close'], input);
    done();
  }
});

test(':q refuses unsaved changes with E37; :q! discards them', async () => {
  const refused = setup({ dirty: true });
  await refused.ex('q');
  assert.deepEqual(refused.calls, ['message: E37: No write since last change (add ! to override)']);
  refused.done();
  for (const input of ['q!', 'qa!', 'quit!']) {
    const { calls, ex, done } = setup({ dirty: true });
    await ex(input);
    assert.deepEqual(calls, ['close'], input);
    done();
  }
});

test('file names are not accepted by :w or :wq', async () => {
  const { calls, ex, done } = setup({ dirty: true });
  await ex('w other.md');
  await ex('wq other.md');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.startsWith('message: ')));
  done();
});

test('substitute and other s-commands still work alongside :saveas', async () => {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'cat', extensions: [vim()] }) });
  Vim.handleEx(getCM(view), 's/cat/dog/');
  assert.equal(view.state.doc.toString(), 'dog');
  view.destroy();
});
