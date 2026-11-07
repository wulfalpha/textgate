import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { wikiLinks, noteLinkAt, splitNoteLink, wikiLinkTarget, wikiIdDestination } from './note-links.js';
import { history, undo } from '@codemirror/commands';
import { createRenderer } from './markdown.js';
import { excludedRanges } from './spellcheck.js';

const state = (doc, head) => EditorState.create({ doc, selection: { anchor: head },
  extensions: [markdown({ base: markdownLanguage, extensions: [wikiLinks] })] });

test('missing wiki creation updates only the clicked destination and preserves alias, fragment and undo', () => {
  const source = '[[Next#part|Label]] `[[Next#part]]` [[Next#part]]';
  let current = EditorState.create({ doc: source, extensions: [history(), markdown({ base: markdownLanguage, extensions: [wikiLinks] })] });
  const target = wikiLinkTarget(current, 'Next#part', { occurrence: 1 });
  assert.equal(target.from, source.lastIndexOf('Next#part'));
  current = current.update({ changes: { from: target.from, to: target.to, insert: wikiIdDestination('Next#part', '202611071530', target.aliased) } }).state;
  assert.equal(current.doc.toString(), '[[Next#part|Label]] `[[Next#part]]` [[202611071530#part|Next#part]]');
  assert.ok(undo({ state: current, dispatch: (transaction) => { current = transaction.state; } }));
  assert.equal(current.doc.toString(), source);
  const aliased = wikiLinkTarget(current, 'Next#part', { position: 5 });
  assert.equal(wikiIdDestination('Next#part', '202611071530', aliased.aliased), '202611071530#part');
  assert.equal(wikiLinkTarget(current, 'Next#part', { position: source.indexOf('`') + 4 }), null);
});

test('encoded desktop preview hrefs locate the original wiki source and preserve its readable title', () => {
  const current = state('[[Next note#café]] [[Next note#café|Alias]]', 4);
  const target = wikiLinkTarget(current, 'Next%20note#caf%C3%A9', { occurrence: 1 });
  assert.equal(target.href, 'Next note#café');
  assert.equal(target.aliased, true);
  assert.equal(current.sliceDoc(target.from, target.to), 'Next note#café');
  assert.equal(wikiLinkTarget(current, 'Next%20note#caf%C3%A9', { expectedCount: 3 }), null,
    'additional raw HTML or mismatched preview links must not select a different source occurrence');
});

test('wiki links parse their destination and alias without rewriting source', () => {
  for (const source of ['[[Note name]]', '[[folder/Note#heading|Display name]]']) {
    const parsed = state(source, 4);
    assert.equal(parsed.doc.toString(), source);
    assert.deepEqual(noteLinkAt(parsed), { href: source.slice(2, -2).split('|')[0], wiki: true });
  }
});

test('wiki destinations are excluded from spelling while alias prose remains eligible', () => {
  const source = '[[folder/Note|Readable alias]]';
  const excluded = excludedRanges(state(source, 5), 0, source.length);
  assert.deepEqual(excluded.map(([from, to]) => source.slice(from, to)), ['folder/Note']);
});

test('code, front matter, escaped brackets and embeds are not editor note links', () => {
  for (const [source, position] of [['`[[Note]]`', 5], ['```\n[[Note]]\n```', 7], ['\\[[Note]]', 5],
    ['---\nname: [[Note]]\n---\n', 13], ['![[Note]]', 5]]) {
    assert.equal(noteLinkAt(state(source, position)), null, source);
  }
});

test('inline Markdown destinations and fragments are available at the cursor', () => {
  const source = '[Next](<notes/Next Note.md#section>)';
  assert.deepEqual(noteLinkAt(state(source, 3)), { href: 'notes/Next Note.md#section', wiki: false });
  assert.deepEqual(splitNoteLink('notes/Next%20Note.md#caf%C3%A9'), { path: 'notes/Next Note.md', fragment: 'café' });
  assert.deepEqual(splitNoteLink('#here'), { path: '', fragment: 'here' });
  for (const href of ['https://example.com', 'HTTPS://example.com', 'mailto:a@b.test', 'file:///etc/note.md', '//host/share.md', '/absolute.md', 'a.md?query']) {
    assert.equal(splitNoteLink(href), null, href);
  }
  assert.throws(() => splitNoteLink('bad%ZZ.md'), /invalid URL/);
});

test('browser preview renders wiki links safely and skips code, front matter and embeds', async () => {
  const dom = new JSDOM('');
  const render = createRenderer({ desktop: false, purifier: createDOMPurify(dom.window) });
  const fragment = await render('---\nname: [[Hidden]]\n---\n\n[[Note name|Label]] `[[Code]]` ![[Embed]] \\[[Escaped]]\n\n[[javascript:alert(1)|Unsafe]]');
  const links = [...fragment.querySelectorAll('a')];
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute('href'), 'Note name');
  assert.equal(links[0].getAttribute('data-wikilink'), 'true');
  assert.equal(links[0].textContent, 'Label');
  assert.equal(links[1].getAttribute('href'), null);
  assert.doesNotMatch(fragment.textContent, /Hidden/);
  assert.match(fragment.textContent, /\[\[Code\]\]/);
  dom.window.close();
});
