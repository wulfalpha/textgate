import test from 'node:test';
import assert from 'node:assert/strict';
import { renameCandidates } from './rename-links.js';

test('rename spans select parsed destinations, reference definitions once, and preserve untouched bytes', async () => {
  const text = '\ufeff---\r\nkey: [[Old]]\r\n---\r\n\r\n[Label](<Old%20note.md#part> "Title")\r\n[[Old note#part|Alias]]\n[A][ref] [B][ref]\r\n\r\n[ref]: <Old%20note.md> "Title"\n\n`[[Old]]` ![image](Old.md)\n\n```md\n[[Old]]\n```\n';
  const files = await renameCandidates([{ key: 1, text }]);
  const values = files[0].spans.map(({ from, to }) => text.slice(from, to));
  assert.deepEqual(values, ['Old%20note.md#part', 'Old note#part', 'Old%20note.md']);
  assert.equal(files[0].spans.filter((span) => span.reference).length, 1);
  let changed = text;
  for (const span of [...files[0].spans].reverse()) changed = changed.slice(0, span.from) + 'NEW' + changed.slice(span.to);
  assert.equal(changed, text.replace('Old%20note.md#part', 'NEW').replace('Old note#part', 'NEW').replace('Old%20note.md>', 'NEW>'));
});
