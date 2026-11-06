import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRecovery } from './session-recovery.js';
import { createActionRunner } from './action-runner.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let now = 0, next = 1;
  const tasks = new Map();
  return {
    setTimeout(fn, delay) { const id = next++; tasks.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(amount) {
      const end = now + amount;
      while (true) {
        const first = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at;
        tasks.delete(first[0]);
        first[1].fn();
      }
      now = end;
    },
  };
}
function setup(overrides = {}) {
  const timers = clock(), writes = [], warnings = [];
  let snapshot = { tabs: [{ document: 7, contents: 'draft', dirty: true, anchor: 1, head: 1 }], active: 0 };
  const recovery = createSessionRecovery({ timers, enqueue: async (action) => action(),
    capture: async () => structuredClone(snapshot), report: (warning) => warnings.push(warning),
    invoke: async (command, args) => {
      if (command === 'restore_session') return { tabs: [], active: 0, warnings: [] };
      writes.push(args.checkpoint);
    }, ...overrides,
  });
  return { recovery, timers, writes, warnings, setSnapshot(value) { snapshot = value; } };
}

test('checkpoints wait for restoration, debounce pauses, and do not starve during sustained typing', async () => {
  const env = setup();
  env.recovery.schedule();
  env.timers.advance(5000);
  await tick();
  assert.equal(env.writes.length, 0);
  await env.recovery.restore();
  env.recovery.start();
  env.timers.advance(499);
  await tick();
  assert.equal(env.writes.length, 0);
  env.timers.advance(1);
  await tick();
  assert.equal(env.writes.length, 1);
  for (let i = 0; i < 8; i++) {
    env.recovery.schedule();
    env.timers.advance(400);
    await tick();
  }
  assert.ok(env.writes.length >= 2, 'the three-second deadline writes despite continuous typing');
  assert.equal(env.writes[0].closed, false);
});

test('capture happens inside the queue and an explicitly closed tab is not revived by queued writes', async () => {
  let queued;
  const env = setup({ enqueue: (action) => new Promise((resolve) => { queued = async () => { await action(); resolve(); }; }) });
  env.recovery.start();
  const pending = env.recovery.flush();
  await tick();
  env.setSnapshot({ tabs: [], active: 0 });
  await queued();
  await pending;
  assert.equal(env.writes[0].tabs.length, 0, 'no earlier snapshot is captured outside the queue');

  const old = env.recovery.flush();
  await tick();
  await env.recovery.finish();
  assert.equal(env.writes.at(-1).closed, true);
  const count = env.writes.length;
  await queued();
  await old;
  env.timers.advance(5000);
  await tick();
  assert.equal(env.writes.length, count, 'a queued periodic write cannot overwrite clean shutdown');
});

test('checkpoint failures are reported, retried, and block successful clean close', async () => {
  let fail = true;
  const env = setup({ invoke: async () => { if (fail) throw new Error('disk full'); } });
  env.recovery.start();
  assert.equal(await env.recovery.finish(), false);
  assert.match(env.warnings.at(-1), /disk full/);
  fail = false;
  await env.recovery.flush();
  assert.equal(env.warnings.at(-1), '');
  assert.equal(await env.recovery.finish(), true);
});

test('clean-close checkpointing inside a file action cannot deadlock on queued background work', async () => {
  const run = createActionRunner({ onBusy: assert.fail, onError: assert.fail });
  const env = setup({ enqueue: (action) => run.enqueue(action, { silent: true }) });
  env.recovery.start();
  await run(async () => {
    const pending = env.recovery.flush();
    await tick();
    assert.equal(await env.recovery.finish(), true);
    // The pending action is intentionally not awaited inside this file action.
    void pending;
  });
  await tick();
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].closed, true);
});

test('closing one approved tab checkpoints its exclusion before its editor state is discarded', async () => {
  const env = setup();
  env.recovery.start();
  assert.equal(await env.recovery.commit(async () => ({ tabs: [], active: 0 })), true);
  assert.equal(env.writes[0].tabs.length, 0);
  assert.equal(env.writes[0].closed, false);
});
