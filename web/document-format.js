import { StateEffect, StateField } from '@codemirror/state';
import { invertedEffects, isolateHistory } from '@codemirror/commands';

// The editor works on LF text. Remember how the file spelled line endings and
// its byte order mark so saving writes the same bytes back.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const defaultFormat = Object.freeze({ bom: false, lineEnding: '\n', mixed: false });

export function decodeDocument(bytes) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    // Lossy decoding would replace bytes with U+FFFD and corrupt the file on save.
    throw new Error('This file is not valid UTF-8 text, so it was not opened.');
  }
  const bom = text.startsWith('﻿');
  if (bom) text = text.slice(1);
  const counts = { '\r\n': 0, '\n': 0, '\r': 0 };
  const endings = Array.from(text.matchAll(/\r\n|\n|\r/g), ([ending]) => ending);
  for (const ending of endings) counts[ending]++;
  const used = Object.keys(counts).filter((ending) => counts[ending] > 0);
  const lineEnding = used.length ? used.reduce((a, b) => (counts[b] > counts[a] ? b : a)) : '\n';
  return { text: text.replace(/\r\n?/g, '\n'), format: { bom, lineEnding, mixed: used.length > 1, endings: used.length > 1 ? endings : null } };
}

export function encodeDocument(text, format = defaultFormat) {
  let index = 0;
  const body = text.replace(/\n/g, () => format.endings?.[index++] ?? format.lineEnding);
  return (format.bom ? '﻿' : '') + body;
}

export function lineEndingLabel(format) {
  return { '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' }[format.lineEnding];
}

// Only mixed files need per-break metadata. Uniform files retain their cheap
// single-style representation. Metadata lives in editor state so a pending save
// can serialize an immutable snapshot even while the user continues editing.
const restoreEndings = StateEffect.define();
export const documentFormat = StateField.define({
  create: () => defaultFormat,
  update(format, transaction) {
    const restorations = transaction.effects.filter((effect) => effect.is(restoreEndings));
    // A grouped undo carries snapshots in reverse edit order; the last one
    // describes the state before the entire group. Redo follows the same rule.
    if (restorations.length) return restorations.at(-1).value;
    if (!transaction.docChanged || !format.endings) return format;
    if (transaction.newDoc.eq(transaction.startState.doc)) return format;
    const ranges = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const start = transaction.startState.doc.lineAt(from).number - 1;
      const end = transaction.startState.doc.lineAt(to).number - 1;
      if (end !== start || inserted.lines > 1) ranges.push({ start, end, count: inserted.lines - 1 });
    });
    let endings = format.endings;
    if (ranges.length) {
      const pieces = [];
      let cursor = 0;
      for (const { start, end, count } of ranges) {
        pieces.push(endings.slice(cursor, start), Array(count).fill(format.lineEnding));
        cursor = end;
      }
      pieces.push(endings.slice(cursor));
      endings = pieces.flat();
    }
    // Removing text between CR and LF must not collapse two logical breaks
    // into one CRLF on reopening. Keep the blank line by spelling LF as CRLF.
    // Only inspect adjacency near changed ranges for ordinary character edits.
    transaction.changes.iterChanges((_from, _to, from, to) => {
      const first = Math.max(0, transaction.newDoc.lineAt(from).number - 2);
      const last = Math.min(endings.length - 2, transaction.newDoc.lineAt(to).number - 1);
      for (let index = first; index <= last; index++) {
        if (endings[index] === '\r' && endings[index + 1] === '\n' && transaction.newDoc.line(index + 2).length === 0) {
          if (endings === format.endings) endings = endings.slice();
          endings[index + 1] = '\r\n';
        }
      }
    });
    return endings === format.endings ? format : { ...format, endings };
  },
});

export function preserveDocumentFormat(format = defaultFormat) {
  return [
    documentFormat.init(() => format),
    invertedEffects.of((transaction) => {
      const before = transaction.startState.field(documentFormat);
      return before === transaction.state.field(documentFormat) ? [] : [restoreEndings.of(before)];
    }),
  ];
}

// Compare serialized formats only after the cheap document equality check.
export function sameDocumentFormat(a, b, doc) {
  if (a === b) return true;
  if (a.bom !== b.bom) return false;
  for (let index = 0; index < doc.lines - 1; index++) {
    if ((a.endings?.[index] ?? a.lineEnding) !== (b.endings?.[index] ?? b.lineEnding)) return false;
  }
  return true;
}

export function normalizeLineEndings(view, lineEnding) {
  if (!['\n', '\r\n', '\r'].includes(lineEnding)) throw new Error('Unknown line ending.');
  const before = view.state.field(documentFormat);
  const after = { ...before, lineEnding, mixed: false, endings: null };
  if (sameDocumentFormat(before, after, view.state.doc)) return false;
  view.dispatch(view.state.update({
    effects: restoreEndings.of(after),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.normalize',
  }));
  return true;
}


// Discard approval must cover format-only edits as well as visible text.
export function snapshotDocument(state) {
  const doc = state.doc;
  const format = state.field(documentFormat);
  return { doc, format, eq: (other) => doc.eq(other.doc) && sameDocumentFormat(format, other.format, doc) };
}
