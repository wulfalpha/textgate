import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { clampWidth, setupSidebarWidth, sidebarWidths } from './sidebar-width.js';

const dom = installDom('<!doctype html><main><aside></aside><div id="handle" role="separator"></div></main>');

function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k), values };
}

test('widths stay within limits and leave room for the editor', () => {
  assert.equal(clampWidth(50), sidebarWidths.min);
  assert.equal(clampWidth(900), sidebarWidths.max);
  assert.equal(clampWidth(300, 1000), 300);
  assert.equal(clampWidth(480, 600), 270);
  assert.equal(clampWidth(480, 200), sidebarWidths.min, 'never below the minimum');
});

test('the remembered width applies at startup; keys change it, Enter and double-click reset it', () => {
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true });
  const main = document.querySelector('main');
  const handle = document.getElementById('handle');
  const storage = memory({ 'textgate.sidebar-width': '260' });
  setupSidebarWidth({ handle, main, storage, window: dom.window });
  assert.equal(main.style.getPropertyValue('--sidebar-width'), '260px');
  assert.equal(handle.getAttribute('aria-valuenow'), '260');
  const key = (name) => handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  key('ArrowRight');
  assert.equal(storage.values.get('textgate.sidebar-width'), String(260 + sidebarWidths.step));
  key('Home');
  assert.equal(main.style.getPropertyValue('--sidebar-width'), `${sidebarWidths.min}px`);
  key('Enter');
  assert.equal(main.style.getPropertyValue('--sidebar-width'), '');
  assert.equal(storage.values.has('textgate.sidebar-width'), false);
  key('End');
  handle.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(storage.values.has('textgate.sidebar-width'), false);
});
