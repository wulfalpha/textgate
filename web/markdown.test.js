import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { headings, createRenderer, sanitize, frontMatterEnd } from './markdown.js';
const window = new JSDOM('').window;
const purifier = createDOMPurify(window);
const html = (fragment) => { const div = window.document.createElement('div'); div.append(fragment); return div.innerHTML; };
const state = (doc) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });

test('browser fallback renders GFM tables and strikethrough', async () => {
  const render = createRenderer({ desktop: false, purifier });
  const output = html(await render('| Name | Status |\n| --- | --- |\n| Textgate | ~~pending~~ |'));
  assert.match(output, /<table>/);
  assert.match(output, /<del>pending<\/del>/);
});

test('desktop rendering goes through the Rust command', async () => {
  const calls = [];
  const render = createRenderer({ desktop: true, purifier, invoke: async (command, args) => { calls.push([command, args]); return '<p>ok</p>'; } });
  assert.equal(html(await render('ok')), '<p>ok</p>');
  assert.deepEqual(calls, [['render_markdown', { source: 'ok' }]]);
});

test('sanitizing removes executable HTML and javascript links', () => {
  const output = html(sanitize('<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a><form><input type="text"></form>', purifier));
  assert.doesNotMatch(output, /<script|onerror|href="javascript:|<input|<form/);
});

test('real comrak output keeps GFM and drops anything interactive or unsafe', () => {
  // Pinned by the matches_the_sanitizer_fixture test in src/markdown.rs.
  const fragment = sanitize(readFileSync(new URL('./fixtures/comrak-sample.html', import.meta.url), 'utf8'), purifier);
  const ids = [...fragment.querySelectorAll('[id]')].map((element) => element.id);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => id.startsWith('user-content-')), ids.join());
  for (const selector of ['dialog', 'textarea', 'button', 'select', 'video', 'input', '[data-footnote-ref]']) {
    assert.equal(fragment.querySelector(selector), null, selector);
  }
  const hrefs = [...fragment.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  for (const kept of ['https://example.com', 'mailto:a@example.com', './notes.md', '#status', '#fn-1']) assert.ok(hrefs.includes(kept), kept);
  assert.ok(!hrefs.some((href) => /^(javascript|ftp):/i.test(href ?? '')), hrefs.join());
  assert.equal(fragment.querySelector('img').getAttribute('src'), './image.png');
  assert.equal(fragment.querySelector('td[align="right"]').textContent, 'b');
  assert.ok(fragment.querySelector('ul.contains-task-list'));
  assert.ok(fragment.querySelector('.markdown-alert-title'));
  assert.ok(fragment.querySelector('details > summary'));
  assert.ok(fragment.querySelector('section.footnotes li#user-content-fn-1'));
});

test('task checkboxes become symbols', () => {
  const output = html(sanitize('<ul><li><input type="checkbox" disabled=""> Todo</li><li><input type="checkbox" checked="" disabled=""> Done</li></ul>', purifier));
  assert.match(output, /☐/);
  assert.match(output, /☑/);
  assert.doesNotMatch(output, /<input/);
});

test('outline excludes code and front matter and preserves source positions', () => {
  const source = '---\ntitle: x\n---\n# First\n\n```md\n# Not a heading\n```\n\nSecond\n------\n\n### Third ###\n\n> # Quoted\n';
  assert.deepEqual(headings(state(source)), [
    { text: 'First', depth: 1, offset: source.indexOf('# First') },
    { text: 'Second', depth: 2, offset: source.indexOf('Second') },
    { text: 'Third', depth: 3, offset: source.indexOf('### Third') },
  ]);
});

test('outline positions include reference definitions', () => {
  const source = '[link]: https://example.com\n\n# Heading\n';
  assert.equal(headings(state(source))[0].offset, source.indexOf('# Heading'));
});

test('front matter is detected only at the start', () => {
  assert.equal(frontMatterEnd('---\na: 1\n---\nbody'), 13);
  assert.equal(frontMatterEnd('text\n---\na: 1\n---\n'), 0);
});
