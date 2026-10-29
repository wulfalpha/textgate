import test from 'node:test';
import assert from 'node:assert/strict';
import { setupExternalOpen } from './external-open.js';
import { createActionRunner } from './action-runner.js';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('startup and later native requests drain once, including arrivals while busy', async () => {
  const pending = [{ kind: 'file', path: '/startup.md', create: true }];
  const opened = [], errors = [];
  let wake, finishSave, listening = false;
  const run = createActionRunner({ onBusy: assert.fail, onError: (e) => errors.push(e.message) });
  const saving = run(() => new Promise((resolve) => { finishSave = resolve; }));
  const ready = setupExternalOpen({ desktop: true, run,
    listen: async (event, listener) => { assert.equal(event, 'open-request'); listening = true; wake = listener; return () => { listening = false; }; },
    invoke: async (command) => { assert.equal(listening, true); assert.equal(command, 'take_open_requests'); return pending.splice(0); },
    openPath: async (...args) => opened.push(args), report: assert.fail,
  });
  await tick();
  assert.deepEqual(opened, []);
  pending.push({ kind: 'error', message: 'One file at a time' }, { kind: 'file', path: '/later.md', create: false });
  wake(); wake();
  finishSave();
  await saving;
  const dispose = await ready;
  assert.deepEqual(opened, [['/startup.md', { create: true }], ['/later.md', { create: false }]]);
  assert.deepEqual(errors, ['One file at a time']);
  dispose();
  assert.equal(listening, false);
});

test('browser-only mode does not subscribe or invoke native commands', async () => {
  const dispose = await setupExternalOpen({ desktop: false, listen: assert.fail, invoke: assert.fail });
  dispose();
});
