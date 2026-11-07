import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBacklinks, renderBacklinks, openBacklink } from './backlinks.js';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening a backlink awaits native document lookup and reuses a dirty or deleted open source', async () => {
  const lookup = deferred(), shown = [], opened = [];
  const tab = { contents: 'unsaved source', deleted: true };
  const pending = openBacklink({ document: 17, path: '/deleted.md' }, {
    findOpen: (id) => { assert.equal(id, 17); return lookup.promise; },
    show: (value) => shown.push(value), open: (path) => opened.push(path),
  });
  assert.equal(shown.length, 0);
  lookup.resolve(tab); await pending;
  assert.deepEqual(shown, [tab]); assert.deepEqual(opened, []);
  await openBacklink({ document: null, path: '/closed.md' }, {
    findOpen: () => assert.fail('closed note has no open handle'), show: () => assert.fail(), open: (path) => opened.push(path),
  });
  assert.deepEqual(opened, ['/closed.md']);
});
function timerQueue() {
  let next = 0;
  const pending = new Map();
  return { setTimeout(fn) { const id = ++next; pending.set(id, fn); return id; }, clearTimeout(id) { pending.delete(id); },
    fire() { const [id, fn] = pending.entries().next().value ?? []; if (!fn) return false; pending.delete(id); fn(); return true; },
    get count() { return pending.size; } };
}

test('new buffer/workspace snapshots supersede pending results and scans never overlap', async () => {
  const timers = timerQueue();
  let generation = 1, active = 0, maximum = 0;
  const requests = [], rendered = [];
  const controller = createBacklinks({ timers, visible: () => true,
    capture: () => { const value = generation; return { value, unchanged: () => value === generation }; },
    query: (snapshot) => { active++; maximum = Math.max(maximum, active); const request = deferred(); requests.push({ ...request, snapshot }); return request.promise.finally(() => active--); },
    render: (value) => rendered.push(value),
  });
  controller.invalidate(); timers.fire(); await turn();
  generation = 2; controller.invalidate(); timers.fire(); await turn();
  assert.equal(requests.length, 1);
  requests[0].resolve({ entries: ['obsolete workspace'] }); await turn();
  assert.equal(rendered.filter((value) => value.result).length, 0);
  timers.fire(); await turn();
  requests[1].resolve({ entries: ['current workspace'] }); await turn();
  assert.deepEqual(rendered.filter((value) => value.result).map((value) => value.result.entries), [['current workspace']]);
  assert.equal(maximum, 1);
  controller.dispose(); assert.equal(timers.count, 0);
});

test('unchanged guards reject stale text even without invalidation and hidden results never paint', async () => {
  const timers = timerQueue(), request = deferred(), rendered = [];
  let unchanged = true, visible = true;
  const controller = createBacklinks({ timers, visible: () => visible,
    capture: () => ({ unchanged: () => unchanged }), query: () => request.promise, render: (value) => rendered.push(value) });
  controller.refresh(); timers.fire(); await turn();
  unchanged = false; visible = false;
  request.resolve({ entries: ['stale'] }); await turn();
  assert.equal(rendered.filter((value) => value.result).length, 0);
  assert.equal(timers.count, 0); controller.dispose();
});

test('backlink rows render source text safely, show partial results and navigate the selected occurrence', () => {
  const dom = new JSDOM('<p id="status"></p><p id="warning"></p><nav></nav>');
  const document = dom.window.document;
  const opened = [];
  const options = { document, container: document.querySelector('nav'), status: document.getElementById('status'), warning: document.getElementById('warning'), open: (entry) => opened.push(entry) };
  const entry = { path: '/notes/Source.md', line: 7, column: 3, context: '<img src=x onerror=evil()> [[target]]' };
  renderBacklinks(options, { result: { entries: [entry], warnings: ['Unreadable note'], scanned: 4 } });
  assert.equal(document.querySelector('img'), null);
  assert.match(options.warning.textContent, /Partial results/);
  assert.match(options.container.textContent, /Source.md:7/);
  options.container.querySelector('button').click(); assert.deepEqual(opened, [entry]);
  const row = options.container.querySelector('button');
  renderBacklinks(options, { busy: true }); assert.equal(row.disabled, true);
  renderBacklinks(options, { result: { entries: [entry], warnings: ['Unreadable note'], scanned: 4 } });
  assert.equal(options.container.querySelector('button'), row, 'unchanged polling preserves focused row elements');
  assert.equal(row.disabled, false);
  renderBacklinks(options, { error: 'Open a folder' }); assert.equal(options.status.textContent, 'Open a folder');
  dom.window.close();
});

test('counts distinguish linking notes from occurrences and relative paths distinguish equal filenames', () => {
  const dom = new JSDOM('<p id="status"></p><p id="warning"></p><nav></nav>');
  const document = dom.window.document;
  const options = { document, container: document.querySelector('nav'), status: document.getElementById('status'), warning: document.getElementById('warning'), open() {} };
  const entries = [
    { path: '/workspace/projects/Notes.md', label: 'projects/Notes.md', line: 2, context: '[[target]]' },
    { path: '/workspace/projects/Notes.md', label: 'projects/Notes.md', line: 4, context: '[[target]] again' },
    { path: '/workspace/journal/Notes.md', label: 'journal/Notes.md', line: 7, context: '[[target]]' },
  ];
  renderBacklinks(options, { result: { entries, warnings: [], scanned: 5 } });
  assert.equal(options.status.textContent, '2 notes · 3 links');
  assert.match(options.container.textContent, /projects\/Notes.md:2/);
  assert.match(options.container.textContent, /journal\/Notes.md:7/);
  renderBacklinks(options, { result: { entries: entries.slice(0, 1), warnings: ['incomplete scan'], scanned: 1 } });
  assert.equal(options.status.textContent, 'At least 1 note · 1 link');
  dom.window.close();
});
