import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskMonitor, reloadDiskTab } from './disk-monitor.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('a queued scan coalesces focus requests and updates tabs before refreshing the tree', async () => {
  const queue = [], calls = [], updates = [];
  const monitor = createDiskMonitor({
    enqueue: (action) => { const done = deferred(); queue.push(async () => { await action(); done.resolve(); }); return done.promise; },
    invoke: async (_command, args) => { calls.push(args); return { scan: true, documents: [7], warning: null }; },
    update: async (changes) => updates.push(changes), refreshTree: async () => updates.push('tree'), report: () => {},
  });
  const pending = monitor.scan();
  await Promise.resolve();
  assert.equal(monitor.scan(true), pending);
  assert.equal(monitor.scan(true), pending);
  assert.equal(queue.length, 1);
  await queue.shift()();
  await pending;
  assert.deepEqual(calls, [{ force: true, folders: [] }]);
  assert.deepEqual(updates, [[7], 'tree']);
});

test('a failed scan reports the problem and the next scan can retry', async () => {
  let fail = true;
  const messages = [], changes = [];
  const monitor = createDiskMonitor({ enqueue: (action) => action(), invoke: async () => {
    if (fail) throw new Error('offline');
    return { scan: true, documents: [3], warning: 'watch fallback' };
  }, update: async (items) => changes.push(items), refreshTree: async () => {}, report: (message) => messages.push(message) });
  await monitor.scan();
  assert.match(messages[0], /offline/);
  fail = false;
  await monitor.scan();
  assert.deepEqual(changes, [[3]]);
  assert.equal(messages[1], 'watch fallback');
});

test('typing while a disk read is pending keeps editor text and the old native baseline', async () => {
  const read = deferred();
  let text = 'old', kept = 0, applied = 0;
  const tab = { path: '/notes.md', file: { read: () => read.promise, remember: async () => kept++ } };
  const pending = reloadDiskTab({ tab, snapshot: () => text, unchanged: (_tab, before) => text === before,
    decode: (value) => value, apply: () => applied++ });
  text = 'new unsaved typing';
  read.resolve('outside edit');
  assert.equal(await pending, false);
  assert.equal(applied, 0);
  assert.equal(kept, 0);
  assert.equal(text, 'new unsaved typing');
});

test('reload applies bytes before committing the baseline and keeps later typing', async () => {
  const calls = [], remember = deferred();
  let text = 'old';
  const tab = { path: '/notes.md', file: { read: async () => 'outside', remember: async () => { calls.push('keep'); await remember.promise; } } };
  const pending = reloadDiskTab({ tab, snapshot: () => text, unchanged: (_tab, before) => text === before,
    decode: (value) => value, apply: (_tab, value) => { calls.push('apply'); text = value; } });
  await Promise.resolve();
  assert.deepEqual(calls, ['apply', 'keep']);
  text += ' typed while committing';
  remember.resolve();
  assert.equal(await pending, true);
  assert.equal(text, 'outside typed while committing');
});

test('failed native baseline commit leaves the reloaded text marked unsaved', async () => {
  const tab = { path: '/notes.md', file: { read: async () => 'outside', remember: async () => { throw new Error('gone'); } } };
  await assert.rejects(reloadDiskTab({ tab, snapshot: () => 'old', unchanged: () => true,
    decode: (value) => value, apply: () => {} }), /gone/);
  assert.equal(tab.recovered, true);
});
