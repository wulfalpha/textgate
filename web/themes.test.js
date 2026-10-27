import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { applyTheme, setupThemes } from './themes.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function fixture(t) {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  return dom;
}

test('themes restore, select, reload, reset and preserve last theme on failure', async (t) => {
  const { window } = fixture(t);
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  let saved = 'dark.css';
  let css = ':root { --tg-text: pink; }';
  let fail = false;
  const invoke = async (command, { selection }) => {
    assert.equal(command, 'theme_state');
    if (fail) throw new Error('Cannot read theme');
    if (selection !== null) saved = selection;
    return { themes: ['dark.css', 'custom.css'], directory: '/config/textgate/themes', selected: saved, css: saved ? css : '', warning: null };
  };
  await setupThemes({ document, desktop: true, invoke });
  assert.equal($('theme-select').value, 'dark.css');
  assert.equal($('custom-theme').textContent, css);
  assert.equal($('theme-directory').textContent, '/config/textgate/themes');
  $('theme-select').value = 'custom.css';
  await $('theme-select').onchange();
  assert.equal(saved, 'custom.css');
  css = ':root { --tg-text: red; }';
  await $('theme-reload').onclick();
  assert.equal($('custom-theme').textContent, css);
  fail = true;
  $('theme-select').value = 'dark.css';
  await $('theme-select').onchange();
  assert.equal($('theme-select').value, 'custom.css');
  assert.equal($('custom-theme').textContent, css);
  assert.match($('status').textContent, /Cannot read theme/);
  fail = false;
  document.dispatchEvent(new window.KeyboardEvent('keydown', { ctrlKey: true, altKey: true, code: 'Digit0', cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal($('custom-theme').textContent, '');
  assert.equal(saved, '');
  assert.equal($('theme-select').value, '');
});

test('reset requested during startup wins over the pending theme response', async (t) => {
  const { window } = fixture(t);
  let finish;
  const invoke = async (_command, { selection }) => {
    if (selection === null) return new Promise((resolve) => { finish = resolve; });
    assert.equal(selection, '');
    return { themes: [], directory: '/config', selected: '', css: '' };
  };
  const ready = setupThemes({ document: window.document, desktop: true, invoke });
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { ctrlKey: true, altKey: true, code: 'Digit0' }));
  finish({ themes: ['dark.css'], directory: '/config', selected: 'dark.css', css: 'body { color: red; }' });
  await ready;
  assert.equal(window.document.getElementById('custom-theme').textContent, '');
});

test('browser-only mode explains native config and CSS is inserted as text', async (t) => {
  const { window } = fixture(t);
  const { document } = window;
  await setupThemes({ document, desktop: false, invoke: () => assert.fail('Must not invoke native APIs') });
  assert.equal(document.getElementById('theme-select').disabled, true);
  assert.match(document.getElementById('theme-directory').textContent, /desktop app/);
  applyTheme(document, '/* </style><script>bad()</script> */');
  assert.equal(document.querySelectorAll('script').length, 1);
  applyTheme(document, 'body { color: red; }');
  assert.equal(document.querySelectorAll('#custom-theme').length, 1);
});
