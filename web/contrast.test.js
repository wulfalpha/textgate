import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// WCAG AA asks for 4.5:1 for normal-size text. Each text colour is checked
// against the backgrounds it is actually drawn on in web/style.css.
const pairs = {
  text: ['background', 'surface', 'sidebar', 'code-background', 'hover'],
  muted: ['background', 'surface', 'sidebar', 'code-background', 'hover'],
  gutter: ['surface'],
  accent: ['background', 'surface', 'code-background'],
  error: ['background', 'surface'],
  'syntax-keyword': ['surface', 'code-background'],
  'syntax-string': ['surface', 'code-background'],
  'syntax-number': ['surface', 'code-background'],
  'on-accent': ['accent'],
};

const tokens = (file) => Object.fromEntries([...readFileSync(new URL(file, import.meta.url), 'utf8')
  .matchAll(/--tg-([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, value]) => [name, value]));
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const file of ['./style.css', '../themes/light.css', '../themes/dark.css']) {
  test(`${file} text colours meet WCAG AA contrast`, () => {
    const colours = tokens(file);
    const failures = [];
    for (const [text, backgrounds] of Object.entries(pairs)) {
      for (const background of backgrounds) {
        const value = ratio(colours[text], colours[background]);
        if (value < 4.5) failures.push(`${text} on ${background}: ${value.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}
