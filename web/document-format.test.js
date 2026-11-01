import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import assert from 'node:assert/strict';
import { decodeDocument, encodeDocument, defaultFormat, documentFormat, preserveDocumentFormat, normalizeLineEndings, sameDocumentFormat } from './document-format.js';

const bytes = (text) => new TextEncoder().encode(text);

test('line endings and byte order marks round trip byte for byte', () => {
  for (const file of ['# A\n\nB\n', '# A\r\n\r\nB\r\n', '# A\rB\r', '﻿# A\r\nB', 'no newline', '']) {
    const { text, format } = decodeDocument(bytes(file));
    assert.doesNotMatch(text, /\r|﻿/);
    assert.equal(format.mixed, false);
    assert.equal(encodeDocument(text, format), file);
  }
});

test('mixed line endings are reported and preserved exactly', () => {
  const { text, format } = decodeDocument(bytes('a\r\nb\r\nc\nd'));
  assert.equal(format.mixed, true);
  assert.equal(format.lineEnding, '\r\n');
  assert.equal(encodeDocument(text, format), 'a\r\nb\r\nc\nd');
});

test('invalid UTF-8 is refused instead of silently replaced', () => {
  assert.throws(() => decodeDocument(new Uint8Array([0x23, 0x20, 0xff, 0x0a])), /not valid UTF-8/);
});

test('new documents use LF without a byte order mark', () => {
  assert.equal(encodeDocument('a\nb\n', defaultFormat), 'a\nb\n');
});

function editor(file) {
  const { text, format } = decodeDocument(bytes(file));
  let state = EditorState.create({ doc: text, extensions: [history(), preserveDocumentFormat(format)] });
  return {
    get state() { return state; },
    dispatch(transaction) { state = transaction.state; },
    edit(changes) { state = state.update({ changes, annotations: isolateHistory.of('full') }).state; },
    saved() { return encodeDocument(state.doc.toString(), state.field(documentFormat)); },
  };
}

test('mixed UTF-8 documents retain BOM, whitespace, Unicode and final newline bytes', () => {
  for (const file of ['\ufeff# Café  \r\n\tשלום\nend\r', 'a\nb\rc\r\nd', 'a\r\nb\nc\r\n']) {
    const view = editor(file);
    assert.deepEqual(bytes(view.saved()), bytes(file));
    view.edit({ from: 0, insert: 'X' });
    assert.equal(view.saved(), (file.startsWith('\ufeff') ? '\ufeffX' + file.slice(1) : 'X' + file));
    assert.ok(undo(view));
    assert.equal(view.saved(), file);
  }
});

test('inserted and deleted breaks preserve untouched endings through undo, redo and repeated saves', () => {
  const file = '\ufeffa\r\nb\nc\rd\r\n';
  const view = editor(file);
  view.edit({ from: 3, insert: '\nnew' });
  assert.equal(view.saved(), '\ufeffa\r\nb\r\nnew\nc\rd\r\n');
  assert.equal(view.saved(), view.saved(), 'serialization does not consume metadata');
  view.edit({ from: 1, to: 2 });
  assert.equal(view.saved(), '\ufeffab\r\nnew\nc\rd\r\n');
  assert.ok(undo(view));
  assert.equal(view.saved(), '\ufeffa\r\nb\r\nnew\nc\rd\r\n');
  assert.ok(undo(view));
  assert.equal(view.saved(), file);
  assert.ok(redo(view));
  assert.ok(redo(view));
  assert.equal(view.saved(), '\ufeffab\r\nnew\nc\rd\r\n');
});

test('multiple change ranges keep their line endings aligned', () => {
  const view = editor('a\r\nb\nc\rd');
  view.edit([{ from: 0, insert: 'A' }, { from: 4, to: 5, insert: 'C' }]);
  assert.equal(view.saved(), 'Aa\r\nb\nC\rd');
  view.edit([{ from: 2, to: 3 }, { from: 6, insert: '\n' }]);
  assert.equal(view.saved(), 'Aab\nC\r\n\rd');
});


test('explicit normalization is an isolated undoable format change, without rewriting editor text', () => {
  const file = '\ufeffa\r\nb\nc\rd';
  const view = editor(file);
  const original = view.state;
  assert.equal(normalizeLineEndings(view, '\r\n'), true);
  const normalized = view.state;
  assert.equal(view.saved(), '\ufeffa\r\nb\r\nc\r\nd');
  assert.equal(view.state.doc, original.doc);
  assert.equal(sameDocumentFormat(original.field(documentFormat), normalized.field(documentFormat), original.doc), false);
  assert.ok(undo(view));
  assert.equal(view.saved(), file);
  assert.ok(redo(view));
  assert.equal(view.saved(), '\ufeffa\r\nb\r\nc\r\nd');
  assert.equal(normalizeLineEndings(view, '\r\n'), false);
  view.edit({ from: 0, insert: 'X' });
  assert.equal(view.saved(), '\ufeffXa\r\nb\r\nc\r\nd');
  assert.ok(undo(view));
  assert.equal(view.saved(), '\ufeffa\r\nb\r\nc\r\nd');
  assert.ok(undo(view));
  assert.equal(view.saved(), file);
});

test('normalization of a document with no breaks is a no-op', () => {
  const view = editor('no newline');
  assert.equal(normalizeLineEndings(view, '\r\n'), false);
  assert.equal(view.saved(), 'no newline');
});


test('identity replacements preserve mixed endings and snapshots remain immutable', () => {
  const file = 'a\r\nb\nc\rd';
  const view = editor(file);
  const snapshot = view.state;
  view.edit({ from: 0, to: view.state.doc.length, insert: view.state.doc.toString() });
  assert.equal(view.saved(), file);
  view.edit({ from: 0, insert: '\n' });
  assert.equal(encodeDocument(snapshot.doc.toString(), snapshot.field(documentFormat)), file);
});

test('edits cannot merge adjacent CR and LF into a single logical break on disk', () => {
  const view = editor('a\rX\nb');
  view.edit({ from: 2, to: 3 });
  assert.equal(view.state.doc.toString(), 'a\n\nb');
  assert.equal(view.saved(), 'a\r\r\nb');
  assert.equal(decodeDocument(bytes(view.saved())).text, view.state.doc.toString());
  assert.ok(undo(view));
  assert.equal(view.saved(), 'a\rX\nb');
});

test('grouped typing and line-break edits restore all original endings in one undo', () => {
  const view = editor('a\r\nb\nc\rd');
  const file = view.saved();
  for (const insert of ['x', '\n', 'y', '\n']) {
    view.dispatch(view.state.update({ changes: { from: 1, insert }, userEvent: 'input.type' }));
  }
  const edited = view.saved();
  assert.ok(undo(view));
  assert.equal(view.saved(), file);
  assert.ok(redo(view));
  assert.equal(view.saved(), edited);
});
