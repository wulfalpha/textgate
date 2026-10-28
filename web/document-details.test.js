import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { JSDOM } from 'jsdom';
import { analyzeDocument } from './document-analysis.js';
import { createDocumentDetails, detailsDelay, updateOutline } from './document-details.js';

const doc = (source) => Text.of(source.split('\n'));
test('background outline excludes front matter, nested headings and fenced code', async () => {
  const source = '---\ntitle: hidden\n---\n\n# First\n\n```md\n# Hidden\n```\n\n> # Quoted\n\nSecond\n------\n\n### Third ###\n';
  const result = await analyzeDocument(source);
  assert.deepEqual(result.headings, [
    { text: 'First', depth: 1, offset: source.indexOf('# First') },
    { text: 'Second', depth: 2, offset: source.indexOf('Second') },
    { text: 'Third', depth: 3, offset: source.indexOf('### Third') },
  ]);
  assert.equal(result.words, source.trim().split(/\s+/).length);
});

test('analysis reaches headings beyond the editor parse viewport', async () => {
  const source = 'ordinary text\n\n'.repeat(10000) + '# Far away\n';
  const result = await analyzeDocument(source);
  assert.deepEqual(result.headings, [{ text: 'Far away', depth: 1, offset: source.indexOf('# Far') }]);
  assert.equal(result.words, 20003);
  assert.ok(detailsDelay(source.length) > detailsDelay(100));
});

test('new edits cancel obsolete worker jobs and unchanged documents reuse results', async () => {
  const workers = [];
  const details = createDocumentDetails(() => {
    const worker = { postMessage(source) { this.source = source; }, terminate() { this.stopped = true; } };
    workers.push(worker);
    return worker;
  });
  const first = doc('first'), second = doc('second');
  const old = details.get(first);
  assert.equal(details.get(first), old);
  details.invalidate(second);
  assert.equal(await old, null);
  assert.equal(workers[0].stopped, true);
  const next = details.get(second);
  workers[0].onmessage({ data: { result: { words: 999, headings: [] } } });
  assert.equal(workers[1].stopped, undefined, 'late stale results cannot terminate the current job');
  workers[1].onmessage({ data: { result: { words: 1, headings: [] } } });
  assert.deepEqual(await next, { words: 1, headings: [] });
  assert.equal(details.get(second), next);
  assert.equal(workers.length, 2);
});

test('outline retains buttons, updates navigation offsets and pages large lists', () => {
  const dom = new JSDOM('<nav></nav>');
  const nav = dom.window.document.querySelector('nav');
  const headings = Array.from({ length: 600 }, (_, i) => ({ text: `Heading ${i}`, depth: 1, offset: i * 10 }));
  let jumped;
  const navigate = (offset) => { jumped = offset; };
  updateOutline(nav, headings, navigate);
  assert.equal(nav.querySelectorAll('[data-heading]').length, 250);
  const first = nav.firstChild;
  updateOutline(nav, headings.map((heading) => ({ ...heading, offset: heading.offset + 3 })), navigate);
  assert.equal(nav.firstChild, first);
  first.click();
  assert.equal(jumped, 3);
  nav.lastChild.click();
  assert.equal(nav.querySelectorAll('[data-heading]').length, 500);
  updateOutline(nav, [], navigate);
  assert.equal(nav.textContent, 'Headings appear here.');
  dom.window.close();
});
