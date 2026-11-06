import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readVimEnabled, storeVimEnabled } from './vim-preference.js';

test('Vim defaults off, remembers enabling and disabling, and tolerates blocked storage', () => {
  const dom = new JSDOM('', { url: 'http://localhost' });
  const storage = dom.window.localStorage;
  assert.equal(readVimEnabled(storage), false);
  storeVimEnabled(storage, true);
  assert.equal(readVimEnabled(storage), true, 'a new session reads the saved on choice');
  storeVimEnabled(storage, false);
  assert.equal(readVimEnabled(storage), false, 'a new session reads the saved off choice');
  assert.equal(readVimEnabled(null), false);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readVimEnabled(blocked), false);
  assert.doesNotThrow(() => storeVimEnabled(blocked, true));
  dom.window.close();
});
