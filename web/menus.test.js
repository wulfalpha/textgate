import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { setupMenus } from './menus.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
test('native menus dispatch shared actions and synchronize checks and modal state', async (t) => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const created = new Map();
  let installed = false;
  const factory = { new: async (options) => {
    const handle = { ...options, close: async () => {},
      setEnabled: async (enabled) => { handle.enabled = enabled; },
      setChecked: async (checked) => { handle.checked = checked; },
      setAsAppMenu: async () => { installed = true; return null; },
    };
    if (options.id) created.set(options.id, handle);
    return handle;
  } };
  const native = { Menu: factory, MenuItem: factory, CheckMenuItem: factory, Submenu: factory };
  const errors = [];
  const menus = await setupMenus({ document, desktop: true, native, onError: (error) => errors.push(error) });
  assert.ok(installed);
  assert.ok(document.getElementById('menubar').hidden);
  assert.equal(created.get('save-as').accelerator, 'CmdOrCtrl+Shift+S');
  let quitRequests = 0;
  document.getElementById('quit').onclick = () => quitRequests++;
  created.get('quit').action();
  assert.equal(quitRequests, 1);
  document.getElementById('vim').setAttribute('aria-pressed', 'true');
  document.getElementById('vim').disabled = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(created.get('vim').checked);
  assert.equal(created.get('vim').enabled, false);
  document.getElementById('theme-dialog').setAttribute('open', '');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(created.get('quit').enabled, false);
  created.get('quit').action();
  assert.equal(quitRequests, 1);
  assert.deepEqual(errors, []);
  await menus.dispose();
});

test('browser menu supports arrow navigation and Escape', async (t) => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const { document, KeyboardEvent } = dom.window;
  await setupMenus({ document, desktop: false });
  const summary = document.querySelector('#menubar summary');
  summary.focus();
  summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement.id, 'new');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.activeElement, summary);
  assert.equal(summary.parentElement.open, false);
});
