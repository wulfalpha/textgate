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
  for (const [ending] of text.matchAll(/\r\n|\n|\r/g)) counts[ending]++;
  const used = Object.keys(counts).filter((ending) => counts[ending] > 0);
  const lineEnding = used.length ? used.reduce((a, b) => (counts[b] > counts[a] ? b : a)) : '\n';
  return { text: text.replace(/\r\n?/g, '\n'), format: { bom, lineEnding, mixed: used.length > 1 } };
}

export function encodeDocument(text, format = defaultFormat) {
  const body = format.lineEnding === '\n' ? text : text.replace(/\n/g, format.lineEnding);
  return (format.bom ? '﻿' : '') + body;
}

export function lineEndingLabel(format) {
  return { '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' }[format.lineEnding];
}
