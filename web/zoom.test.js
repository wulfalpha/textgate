import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoom, zoomLevels } from './zoom.js';

const memory = (initial = {}) => {
  const values = { ...initial };
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => { values[key] = value; } };
};

test('zoom steps through fixed levels, stops at the ends, and remembers the level', async () => {
  const applied = [];
  const storage = memory();
  const zoom = createZoom({ storage, setZoom: async (value) => { applied.push(value); } });
  assert.equal(zoom.level, 1);
  assert.equal(await zoom.in(), 1.1);
  assert.equal(await zoom.in(), 1.25);
  assert.equal(await zoom.reset(), 1);
  assert.equal(await zoom.out(), 0.9);
  assert.deepEqual(applied, [1.1, 1.25, 1, 0.9]);
  assert.equal(storage.values['textgate.zoom'], '0.9');
  for (const _ of zoomLevels) await zoom.out();
  assert.equal(zoom.level, zoomLevels[0]);
  for (const _ of zoomLevels) await zoom.in();
  assert.equal(zoom.level, zoomLevels.at(-1));
});

test('a saved level is restored; invalid or unreadable values fall back to 100%', async () => {
  const applied = [];
  const zoom = createZoom({ storage: memory({ 'textgate.zoom': '1.5' }), setZoom: async (value) => { applied.push(value); } });
  await zoom.restore();
  assert.deepEqual(applied, [1.5]);
  assert.equal(createZoom({ storage: memory({ 'textgate.zoom': '7' }), setZoom: async () => {} }).level, 1);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const zoom2 = createZoom({ storage: broken, setZoom: async () => {} });
  assert.equal(zoom2.level, 1);
  assert.equal(await zoom2.in(), 1.1, 'still works when storage is unavailable');
});

test('a failed zoom keeps the previous level', async () => {
  const zoom = createZoom({ storage: memory(), setZoom: async () => { throw new Error('denied'); } });
  await assert.rejects(zoom.in(), /denied/);
  assert.equal(zoom.level, 1);
});
