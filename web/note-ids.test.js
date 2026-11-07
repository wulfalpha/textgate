import test from 'node:test';
import assert from 'node:assert/strict';
import { noteId, noteIdCandidates } from './note-ids.js';

test('note IDs are 12-digit local timestamps', () => {
  assert.equal(noteId(new Date(2026, 10, 7, 15, 30, 59)), '202611071530');
  assert.equal(noteId(new Date(2026, 0, 2, 3, 4)), '202601020304');
});

test('candidates start at the current minute and roll over hours, days and years', () => {
  const ids = noteIdCandidates(new Date(2026, 11, 31, 23, 58, 40), 4);
  assert.deepEqual(ids, ['202612312358', '202612312359', '202701010000', '202701010001']);
  assert.equal(noteIdCandidates(new Date(2026, 10, 7, 15, 30)).length, 60);
  assert.ok(noteIdCandidates().every((id) => /^\d{12}$/.test(id)));
});
