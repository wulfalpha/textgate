import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createRenderer, sanitize } from './markdown.js';
import { imageReference, loadImages } from './images.js';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';

const result = { mime: 'image/png', data: 'YQ==' };

test('space-containing image paths work in browser Preview and the Live syntax tree', async () => {
  const dom = new JSDOM('');
  const render = createRenderer({ desktop: false, purifier: createDOMPurify(dom.window) });
  for (const source of ['![Screenshot](<images/My screenshot.png>)', '![Screenshot](images/My%20screenshot.png)',
    '![Screenshot](<images/Screenshot at 6.40.56\u202fPM.png>)']) {
    const fragment = await render(source);
    const image = fragment.querySelector('img');
    assert.ok(image, source);
    assert.ok(imageReference(image.getAttribute('src')).includes(' '));
    const state = EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage })] });
    let found = false;
    syntaxTree(state).iterate({ enter(node) { if (node.name === 'Image' && node.node.getChild('URL')) found = true; } });
    assert.equal(found, true, source);
    assert.equal(state.doc.toString(), source);
  }
  dom.window.close();
});
function setup(html) {
  const dom = new JSDOM('');
  return { dom, fragment: sanitize(html, createDOMPurify(dom.window)) };
}

test('image paths decode local references and reject remote, embedded and absolute sources', () => {
  assert.equal(imageReference('images/a%20b.png?v=2#crop'), 'images/a b.png');
  assert.equal(imageReference('../other/photo.png'), '../other/photo.png');
  for (const source of ['https://example.com/p.png', '//host/p.png', 'file:///a.png', 'data:image/png;base64,YQ==', '/a.png', '\\host\\p.png', '']) {
    assert.throws(() => imageReference(source), /relative local/);
  }
  assert.throws(() => imageReference('bad%ZZ.png'), /invalid URL/);
});

test('local images load through the native document handle, deduplicate and retain alt text', async () => {
  const { dom, fragment } = setup('<p><img src="images/a%20b.png" alt="Description"><img src="images/a%20b.png"></p>');
  const calls = [];
  await loadImages(fragment, { document: 7, invoke: async (command, args) => { calls.push([command, args]); return result; } });
  assert.deepEqual(calls, [['load_note_image', { document: 7, reference: 'images/a b.png' }]]);
  assert.equal(fragment.querySelector('img').getAttribute('alt'), 'Description');
  assert.equal(fragment.querySelector('img').src, 'data:image/png;base64,YQ==');
  assert.equal(fragment.querySelector('img').loading, 'lazy');
  dom.window.close();
});

test('missing and remote images show safe placeholders without loading source URLs', async () => {
  const { dom, fragment } = setup('<img src="https://example.com/a.png" alt="Remote"><img src="missing.png" alt="Missing">');
  let calls = 0;
  await loadImages(fragment, { document: null, invoke: async () => { calls++; throw new Error('Not found'); } });
  assert.equal(calls, 1);
  assert.equal(fragment.querySelector('img'), null);
  assert.match(fragment.textContent, /Remote.*relative local/);
  assert.match(fragment.textContent, /Missing.*Not found/);
  assert.match(fragment.querySelector('.image-placeholder').getAttribute('aria-label'), /Image unavailable.*Remote/);
  dom.window.close();
});

test('image count and aggregate byte limits keep other preview text intact', async () => {
  const { dom, fragment } = setup('<p>Kept text</p><img src="one.png"><img src="two.png"><img src="three.png">');
  await loadImages(fragment, { document: null, maxImages: 2, maxBytes: 1, invoke: async () => result });
  assert.equal(fragment.querySelectorAll('img').length, 1);
  assert.equal(fragment.querySelectorAll('.image-placeholder').length, 2);
  assert.match(fragment.textContent, /Kept text/);
  dom.window.close();
});

test('native responses cannot smuggle active image formats and decode failures become placeholders', async () => {
  const { dom, fragment } = setup('<img src="one.png"><img src="two.png">');
  let calls = 0;
  await loadImages(fragment, { document: null, invoke: async () => ++calls === 1 ? { mime: 'image/svg+xml', data: 'YQ==' } : result });
  assert.equal(fragment.querySelectorAll('.image-placeholder').length, 1);
  fragment.querySelector('img').dispatchEvent(new dom.window.Event('error'));
  assert.equal(fragment.querySelector('img'), null);
  assert.match(fragment.textContent, /could not be decoded/);
  dom.window.close();
});

test('rendering freezes the source tab before waiting for native HTML', async () => {
  const dom = new JSDOM('');
  let finish;
  const html = new Promise((resolve) => { finish = resolve; });
  let active = 7;
  const calls = [];
  const render = createRenderer({ desktop: true, purifier: createDOMPurify(dom.window),
    imageDocument: () => Promise.resolve(active), invoke: async (command, args) => {
      if (command === 'render_markdown') return html;
      calls.push(args); return result;
    } });
  const pending = render('![Picture](picture.png)');
  active = 99;
  finish('<img src="picture.png" alt="Picture">');
  const fragment = await pending;
  assert.equal(calls[0].document, 7);
  assert.equal(fragment.querySelector('img').src, 'data:image/png;base64,YQ==');
  dom.window.close();
});
