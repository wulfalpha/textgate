import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo, undoDepth } from '@codemirror/commands';
import { installDom } from './test-dom.js';
import { decodeDocument, documentFormat, encodeDocument, normalizeLineEndings, preserveDocumentFormat } from './document-format.js';
import { lineEndingMarkers, readShowLineEndings, storeShowLineEndings } from './line-endings.js';

installDom();
const markers = (view) => [...view.dom.querySelectorAll('.cm-line-ending')];
const symbols = (view) => markers(view).map((marker) => marker.textContent);
function make(source, markerExtension = lineEndingMarkers()) {
  const { text, format } = decodeDocument(new TextEncoder().encode(source));
  return new EditorView({ parent: document.body, state: EditorState.create({
    doc: text, extensions: [history(), preserveDocumentFormat(format), markerExtension],
  }) });
}
const bytes = (view) => encodeDocument(view.state.doc.toString(), view.state.field(documentFormat));

test('markers distinguish mixed endings, blank lines and an unterminated last line without changing bytes', () => {
  const source = '\ufeffone\r\n\nthree\rfour';
  const view = make(source);
  assert.deepEqual(symbols(view), ['␍↵', '↵', '␍']);
  assert.deepEqual(markers(view).map((marker) => marker.title), [
    'CRLF (carriage return and line feed)', 'LF (line feed)', 'CR (carriage return)',
  ]);
  for (const marker of markers(view)) {
    assert.equal(marker.getAttribute('aria-hidden'), 'true');
    assert.equal(marker.getAttribute('contenteditable'), 'false');
  }
  assert.equal(bytes(view), source);
  assert.equal(undoDepth(view.state), 0);
  view.destroy();
  const terminated = make('one\n');
  assert.deepEqual(symbols(terminated), ['↵']);
  terminated.destroy();
  const empty = make('');
  assert.deepEqual(symbols(empty), []);
  empty.destroy();
});

test('markers update after typing, normalization and undo/redo', () => {
  const view = make('one\r\ntwo\nthree');
  assert.deepEqual(symbols(view), ['␍↵', '↵']);
  normalizeLineEndings(view, '\r');
  assert.deepEqual(symbols(view), ['␍', '␍']);
  undo(view);
  assert.deepEqual(symbols(view), ['␍↵', '↵']);
  assert.equal(bytes(view), 'one\r\ntwo\nthree');
  redo(view);
  assert.deepEqual(symbols(view), ['␍', '␍']);
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' } });
  assert.deepEqual(symbols(view), ['␍', '␍', '␍']);
  view.destroy();
});

test('showing and hiding markers does not change document, selection, format or undo history', () => {
  const compartment = new Compartment();
  const view = make('one\ntwo', compartment.of([]));
  view.dispatch({ selection: { anchor: 2 } });
  const before = view.state;
  assert.deepEqual(symbols(view), []);
  view.dispatch({ effects: compartment.reconfigure(lineEndingMarkers()) });
  assert.deepEqual(symbols(view), ['↵']);
  view.dispatch({ effects: compartment.reconfigure([]) });
  assert.deepEqual(symbols(view), []);
  assert.equal(view.state.doc, before.doc);
  assert.ok(view.state.selection.eq(before.selection));
  assert.equal(view.state.field(documentFormat), before.field(documentFormat));
  assert.equal(undoDepth(view.state), 0);
  view.destroy();
});

test('the setting defaults off and is remembered even when storage is unavailable', () => {
  const storage = window.localStorage;
  storage.clear();
  assert.equal(readShowLineEndings(storage), false);
  storeShowLineEndings(storage, true);
  assert.equal(readShowLineEndings(storage), true);
  storeShowLineEndings(storage, false);
  assert.equal(readShowLineEndings(storage), false);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readShowLineEndings(blocked), false);
  assert.doesNotThrow(() => storeShowLineEndings(blocked, true));
});
