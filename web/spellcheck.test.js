import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { excludedRanges, readSpellcheck, spellcheck, storeSpellcheck } from './spellcheck.js';

installDom();

function excluded(doc) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return excludedRanges(state, 0, state.doc.length).map(([from, to]) => doc.slice(from, to));
}

test('prose is checked; code, URLs and HTML are not', () => {
  const doc = 'Some wrods with `cnst x` and [a lnk](https://exmaple.com/pth) <span class="x">hi</span> <https://auto.lnk>\n\n```js\nlet vlaue = 1;\n```\n\n    indnted code\n';
  const ranges = excluded(doc);
  assert.ok(ranges.includes('`cnst x`'));
  assert.ok(ranges.includes('https://exmaple.com/pth'));
  assert.ok(ranges.includes('<span class="x">'));
  assert.ok(ranges.some((text) => text.includes('https://auto.lnk')));
  assert.ok(ranges.some((text) => text.includes('let vlaue = 1;')));
  assert.ok(ranges.some((text) => text.includes('indnted code')));
  assert.ok(!ranges.some((text) => /wrods|lnk\]/.test(text)), 'prose and link text stay checked');
});

test('YAML front matter is not checked', () => {
  const ranges = excluded('---\ntitel: x\n---\n# Hedding\n');
  assert.deepEqual(ranges, ['---\ntitel: x\n---\n']);
});

test('the editor enables spellcheck and marks excluded text', () => {
  const doc = 'Plain txt and `cde`.';
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), spellcheck()] }),
  });
  assert.equal(view.contentDOM.getAttribute('spellcheck'), 'true');
  const marked = [...view.contentDOM.querySelectorAll('[spellcheck="false"]')].map((element) => element.textContent).join('');
  assert.equal(marked, '`cde`');
  view.destroy();
  const off = new EditorView({ parent: document.body, state: EditorState.create({ doc }) });
  assert.equal(off.contentDOM.getAttribute('spellcheck'), 'false');
  off.destroy();
});

test('the setting defaults to on and is remembered', () => {
  const values = new Map();
  const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
  assert.equal(readSpellcheck(storage), true);
  storeSpellcheck(storage, false);
  assert.equal(readSpellcheck(storage), false);
  storeSpellcheck(storage, true);
  assert.equal(readSpellcheck(storage), true);
  assert.equal(readSpellcheck({ getItem() { throw new Error('blocked'); } }), true);
  assert.equal(readSpellcheck(null), true);
});
