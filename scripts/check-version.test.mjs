import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersions, checkVersions } from './check-version.mjs';

test('all six repository version fields agree', () => {
  const versions = readVersions();
  assert.equal(Object.keys(versions).length, 6);
  assert.equal(checkVersions(versions, `v${versions['package.json']}`), versions['package.json']);
});

test('each mismatched or missing field blocks a release', () => {
  const versions = readVersions();
  for (const field of Object.keys(versions)) {
    for (const value of ['9.9.9', undefined]) {
      assert.throws(() => checkVersions({ ...versions, [field]: value }));
    }
  }
});

test('a tag must exactly match the version; manual builds need no tag', () => {
  const versions = readVersions();
  assert.doesNotThrow(() => checkVersions(versions));
  for (const tag of ['v9.9.9', versions['package.json'], `v${versions['package.json']}-rc.1`]) {
    assert.throws(() => checkVersions(versions, tag), /tag: expected/);
  }
});
