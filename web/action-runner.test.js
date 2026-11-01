import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionRunner } from './action-runner.js';

test('close during a save shows feedback without closing; retry checks unsaved edits', async () => {
  let finishSave;
  let notices = 0;
  let checks = 0;
  let closed = false;
  let discard = false;
  const run = createActionRunner({ onBusy: () => notices++, onError: assert.fail });
  const saving = run(() => new Promise((resolve) => { finishSave = resolve; }));
  const close = async () => { checks++; if (discard) closed = true; };
  await run(close);
  await run(close);
  assert.equal(notices, 2);
  assert.equal(checks, 0);
  assert.equal(closed, false);
  finishSave();
  await saving;
  assert.equal(closed, false, 'close is not queued');
  await run(close);
  assert.equal(checks, 1);
  assert.equal(closed, false, 'unsaved edits can still block closing');
  discard = true;
  await run(close);
  assert.equal(closed, true);
});

test('a failed file operation reports its error and allows the next action', async () => {
  const error = new Error('Disk full');
  const reported = [];
  let retried = false;
  const run = createActionRunner({ onBusy: assert.fail, onError: (value) => reported.push(value) });
  await run(async () => { throw error; });
  await run(() => { retried = true; });
  assert.deepEqual(reported, [error]);
  assert.equal(retried, true);
});

test('native opens queue behind a write and preserve order after an error', async () => {
  let finish;
  const order = [], errors = [];
  let notices = 0;
  const run = createActionRunner({ onBusy: assert.fail, onError: (error) => errors.push(error.message), onQueued: () => notices++ });
  const saving = run(() => new Promise((resolve) => { finish = () => { order.push('saved'); resolve(); }; }));
  const first = run.enqueue(() => { order.push('first'); throw new Error('bad file'); });
  const second = run.enqueue(() => { order.push('second'); });
  assert.deepEqual(order, []);
  assert.equal(notices, 2);
  finish();
  await Promise.all([saving, first, second]);
  assert.deepEqual(order, ['saved', 'first', 'second']);
  assert.deepEqual(errors, ['bad file']);
});
