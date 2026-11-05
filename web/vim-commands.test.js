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
  tabs: {
    step: (offset) => app.calls.push(`step ${offset}`), go: (position) => app.calls.push(`go ${position}`),
    add: () => app.calls.push('add'), anyDirty: () => app.anyDirty, closeAll: async () => { app.calls.push('closeAll'); },
  },
});

function setup({ dirty = false, saved = true, anyDirty = dirty } = {}) {
  const calls = [];
  const pending = [];
  app = {
    calls, dirty, anyDirty,
    run: (action) => { pending.push(action()); },
    save: async () => { calls.push('save'); return saved; },
    saveAs: async () => { calls.push('saveAs'); return saved; },
    close: async () => { calls.push('close'); },
    message: (text) => calls.push(`message: ${text}`),
  };
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'text', extensions: [vim()] }) });
  const ex = async (input) => { Vim.handleEx(getCM(view), input); await Promise.all(pending); };
  const keys = (input) => { for (const key of input) Vim.handleKey(getCM(view), key, 'user'); };
  return { calls, ex, keys, done: () => view.destroy() };
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

test(':q closes a clean tab', async () => {
  for (const input of ['q', 'quit', 'tabclose', 'tabc']) {
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
  for (const input of ['q!', 'quit!', 'tabc!']) {
    const { calls, ex, done } = setup({ dirty: true });
    await ex(input);
    assert.deepEqual(calls, ['close'], input);
    done();
  }
});

test(':qa closes every tab, refusing with E37 if any has unsaved changes', async () => {
  const clean = setup();
  await clean.ex('qa');
  assert.deepEqual(clean.calls, ['closeAll']);
  clean.done();
  // The current tab is saved, but another one is not.
  const refused = setup({ dirty: false, anyDirty: true });
  await refused.ex('qall');
  assert.deepEqual(refused.calls, ['message: E37: No write since last change (add ! to override)']);
  refused.done();
  const forced = setup({ anyDirty: true });
  await forced.ex('qa!');
  assert.deepEqual(forced.calls, ['closeAll']);
  forced.done();
});

test('gt, gT and the :tab commands switch, open and count tabs as in Vim', async () => {
  const { calls, ex, keys, done } = setup();
  keys('gt'); keys('3gt'); keys('gT'); keys('2gT');
  await ex('tabnext'); await ex('tabn 2'); await ex('tabprevious'); await ex('tabp 3'); await ex('tabN');
  await ex('tabnew'); await ex('tabe');
  assert.deepEqual(calls, ['step 1', 'go 3', 'step -1', 'step -2', 'step 1', 'go 2', 'step -1', 'step -3', 'step -1', 'add', 'add']);
  await ex('tabe other.md');
  assert.match(calls.at(-1), /^message: :tabedit takes no file name/);
  done();
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
