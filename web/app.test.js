import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, forceParsing } from '@codemirror/language';
import { closeSearchPanel } from '@codemirror/search';
import { fencedLanguage } from './source-language.js';
import { installDom } from './test-dom.js';

// Exercise the actual app wiring in a DOM. Native file dialogs remain a desktop check.
test('app switches modes without rewriting Markdown and keeps one undo history', async (t) => {
  const dom = installDom(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const $ = (id) => document.getElementById(id);
  const { flushDetails } = await import('./main.js');
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  const text = () => view.state.doc.toString();
  const replace = (insert) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
  const original = text();

  assert.equal(document.querySelector('main').dataset.mode, 'live');
  assert.ok(view.dom.classList.contains('cm-live'));
  assert.ok(view.contentDOM.querySelector('.tok-strikethrough'), 'strikethrough is styled');
  assert.equal($('dirty').textContent, '');
  assert.equal($('vim').disabled, false);
  assert.equal($('editor-status').textContent, 'Live');
  assert.equal($('toggle-preview').disabled, true);
  $('toggle-outline').click();
  assert.ok(document.querySelector('main').classList.contains('hide-outline'));
  $('toggle-outline').click();

  $('mode-source').click();
  assert.ok(!view.dom.classList.contains('cm-live'));
  assert.equal($('view-source').getAttribute('aria-pressed'), 'true');
  assert.equal(text(), original);
  await flushDetails();
  assert.match($('preview').textContent, /Welcome to Textgate/);
  $('toggle-preview').click();
  assert.ok(document.querySelector('main').classList.contains('hide-preview'));
  $('toggle-preview').click();
  $('mode-live').click();
  assert.equal(text(), original);

  // Edits made in either mode share one history.
  view.dispatch({ changes: { from: 2, insert: 'Edited ' } });
  $('mode-source').click();
  assert.match(text(), /^# Edited Welcome/);
  assert.equal($('dirty').textContent, '●');
  await flushDetails();
  assert.match($('outline').textContent, /Edited Welcome/);
  assert.match($('preview').textContent, /Edited Welcome/);
  $('mode-live').click();
  $('edit-undo').click();
  assert.equal(text(), original);
  assert.equal($('dirty').textContent, '');
  $('edit-redo').click();
  assert.match(text(), /# Edited Welcome/);
  $('edit-undo').click();

  // Toolbar commands edit only their markup.
  replace('Title\n=====\n\n__Hello__ there\n\n* untouched\n');
  view.dispatch({ selection: { anchor: text().indexOf('there'), head: text().indexOf('there') + 5 } });
  document.querySelector('[data-command="bold"]').click();
  assert.equal(text(), 'Title\n=====\n\n__Hello__ **there**\n\n* untouched\n');
  assert.equal(document.querySelector('[data-command="bold"]').getAttribute('aria-pressed'), 'true');
  $('block-type').value = '2';
  $('block-type').dispatchEvent(new window.Event('change'));
  assert.equal(text(), 'Title\n=====\n\n## __Hello__ **there**\n\n* untouched\n');

  $('find').click();
  assert.equal(document.querySelector('main').dataset.mode, 'live');
  assert.ok(document.querySelector('.cm-search input[name="search"]'));
  $('replace').click();
  assert.equal(document.activeElement.getAttribute('name'), 'replace');
  closeSearchPanel(view);

  // HTML, footnotes and front matter are ordinary text in both modes.
  const rich = '---\ntitle: Keep\n---\n<!-- preserve -->\n\nNote[^1].\n\n[^1]: Text\n';
  replace(rich);
  $('mode-source').click();
  $('mode-live').click();
  assert.equal(text(), rich);

  // Document content can't take over app elements, block shortcuts, or throw.
  $('mode-source').click();
  replace('<span id="status">Doc</span>\n\n<dialog open>Trap</dialog>\n\n[bad](#%E0%A4%A) [jump](#target)\n\n<span id="target">Target</span>\n');
  await flushDetails();
  assert.ok($('status').closest('footer'));
  assert.equal($('preview').querySelector('dialog'), null);
  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.message));
  $('preview').querySelector('a[href^="#%E0"]').click();
  assert.deepEqual(errors, []);
  assert.equal($('status').textContent, 'Link: #%E0%A4%A');
  let scrolled = null;
  window.HTMLElement.prototype.scrollIntoView = function () { scrolled = this.id; };
  $('preview').querySelector('a[href="#target"]').click();
  assert.equal(scrolled, 'user-content-target');
  const save = new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(save);
  assert.equal(save.defaultPrevented, true);

  $('mode-source').click();
  assert.equal(fencedLanguage('unknown-language'), null);
  assert.equal(fencedLanguage(''), null);
  assert.equal(fencedLanguage('rust').name, 'Rust');
  for (const label of ['python', 'py', 'Python']) {
    replace('```' + label + '\ndef greet():\n    return "hello"\n```');
    // Wait for the same lazy language description used by the Markdown parser.
    await fencedLanguage(label).load();
    ensureSyntaxTree(view.state, view.state.doc.length, 1000);
    forceParsing(view, view.state.doc.length, 1000);
    assert.ok([...view.contentDOM.querySelectorAll('.tok-keyword')].some((el) => el.textContent === 'def'));
    assert.ok([...view.contentDOM.querySelectorAll('.tok-string')].some((el) => el.textContent.includes('hello')));
  }
  const press = (key, keyCode, options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true, ...options });
    view.contentDOM.dispatchEvent(event);
    return event;
  };
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
  assert.equal(press('Tab', 9).defaultPrevented, true);
  assert.equal(view.state.doc.line(2).text, '  def greet():');
  assert.equal(press('Tab', 9, { shiftKey: true }).defaultPrevented, true);
  assert.equal(view.state.doc.line(2).text, 'def greet():');
  assert.equal(document.activeElement, view.contentDOM);

  view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(3).to } });
  press('Tab', 9);
  assert.equal(view.state.doc.line(2).text, '  def greet():');
  assert.equal(view.state.doc.line(3).text, '      return "hello"');
  press('Tab', 9, { shiftKey: true });
  assert.equal(view.state.doc.line(3).text, '    return "hello"');
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });

  // Vim works in both modes.
  $('mode-live').click();
  $('vim').click();
  assert.match($('editor-status').textContent, /^Live · Vim NORMAL/);
  press('i', 73);
  assert.equal(press('Tab', 9).defaultPrevented, true);
  assert.match(view.state.doc.line(2).text, /^\s+def greet/);
  press('Escape', 27);
  $('vim').click();
  // Escape then Tab is CodeMirror's built-in keyboard-focus escape hatch.
  press('Escape', 27);
  const beforeTab = text();
  assert.equal(press('Tab', 9).defaultPrevented, false);
  assert.equal(text(), beforeTab);

  window.confirm = () => false;
  $('new').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(text(), /greet/);
  window.confirm = () => true;
  $('new').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(text(), '');
  assert.equal($('dirty').textContent, '');
  assert.equal(document.querySelector('[data-command="undo"]').disabled, true);
  await flushDetails();
  view.destroy();
});
