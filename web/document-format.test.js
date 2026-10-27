import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocument, encodeDocument, defaultFormat } from './document-format.js';

const bytes = (text) => new TextEncoder().encode(text);

test('line endings and byte order marks round trip byte for byte', () => {
  for (const file of ['# A\n\nB\n', '# A\r\n\r\nB\r\n', '# A\rB\r', '﻿# A\r\nB', 'no newline', '']) {
    const { text, format } = decodeDocument(bytes(file));
    assert.doesNotMatch(text, /\r|﻿/);
    assert.equal(format.mixed, false);
    assert.equal(encodeDocument(text, format), file);
  }
});

test('mixed line endings are reported and saved with the most common ending', () => {
  const { text, format } = decodeDocument(bytes('a\r\nb\r\nc\nd'));
  assert.equal(format.mixed, true);
  assert.equal(format.lineEnding, '\r\n');
  assert.equal(encodeDocument(text, format), 'a\r\nb\r\nc\r\nd');
});

test('invalid UTF-8 is refused instead of silently replaced', () => {
  assert.throws(() => decodeDocument(new Uint8Array([0x23, 0x20, 0xff, 0x0a])), /not valid UTF-8/);
});

test('new documents use LF without a byte order mark', () => {
  assert.equal(encodeDocument('a\nb\n', defaultFormat), 'a\nb\n');
});
