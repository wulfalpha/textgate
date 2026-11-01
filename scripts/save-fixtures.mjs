import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

// Generate bytes directly so Git's checkout line-ending settings cannot alter
// the fixtures. Use a fresh directory; never overwrite someone's test edits.
const fixtures = {
  'mixed-bom.md': '\ufeff# Source stays authoritative\r\n\r\n__Café__ and שלום.  \n\tKeep this whitespace.\rLast line without a newline',
  'crlf-bom.md': '\ufeff# Windows\r\n\r\n* Keep this list marker\r\n',
  'lf-no-final-newline.md': '# Unix\n\n<!-- keep this comment -->\nFinal line',
  'cr.md': '# Classic Mac\r\rText\r',
};
const verify = process.argv[2] === '--verify';
const directory = process.argv[verify ? 3 : 2];
if (!directory) {
  console.error('Usage: node scripts/save-fixtures.mjs [--verify] <directory>');
  process.exit(1);
}
const root = resolve(directory);
const hash = (data) => createHash('sha256').update(data).digest('hex');
if (!verify) mkdirSync(root, { recursive: true });
for (const [name, text] of Object.entries(fixtures)) {
  const path = join(root, name);
  if (verify) {
    if (!readFileSync(path).equals(Buffer.from(text))) {
      console.error(`CHANGED: ${name}`);
      process.exitCode = 1;
    } else console.log(`Unchanged: ${name}`);
  } else {
    writeFileSync(path, text, { flag: 'wx' });
    console.log(`Created: ${path}`);
  }
}
if (!verify) {
  const sums = Object.entries(fixtures).map(([name, text]) => `${hash(text)}  ${name}`).join('\n') + '\n';
  writeFileSync(join(root, 'SHA256SUMS'), sums, { flag: 'wx' });
}
