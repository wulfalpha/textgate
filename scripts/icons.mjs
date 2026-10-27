// Regenerate desktop icons: icons/source.svg for large sizes and
// icons/source-small.svg (simplified for legibility) for 16–32 px.
// Usage: node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const icons = join(root, 'icons');
const work = mkdtempSync(join(tmpdir(), 'textgate-icons-'));
const generate = (source) => {
  const out = join(work, source);
  execFileSync('npx', ['tauri', 'icon', join(icons, source), '--output', out], { cwd: root, stdio: 'ignore' });
  return out;
};
const large = generate('source.svg');
const small = generate('source-small.svg');

for (const name of ['64x64.png', '128x128.png', '128x128@2x.png', 'icon.png']) copyFileSync(join(large, name), join(icons, name));
copyFileSync(join(small, '32x32.png'), join(icons, '32x32.png'));

// ICO: a directory of 16-byte entries followed by image data.
function readIco(file) {
  const data = readFileSync(file);
  return Array.from({ length: data.readUInt16LE(4) }, (_, index) => {
    const entry = data.subarray(6 + index * 16, 22 + index * 16);
    const size = entry[0] || 256;
    return { size, entry, image: data.subarray(entry.readUInt32LE(12), entry.readUInt32LE(12) + entry.readUInt32LE(8)) };
  });
}
const smallIco = readIco(join(small, 'icon.ico'));
const layers = readIco(join(large, 'icon.ico')).map((layer) => (layer.size <= 32 ? smallIco.find((other) => other.size === layer.size) : layer));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(layers.length, 4);
let offset = 6 + layers.length * 16;
const entries = layers.map(({ entry, image }) => {
  const copy = Buffer.from(entry);
  copy.writeUInt32LE(offset, 12);
  offset += image.length;
  return copy;
});
writeFileSync(join(icons, 'icon.ico'), Buffer.concat([header, ...entries, ...layers.map((layer) => layer.image)]));

// ICNS: 'icns' + length, then typed chunks. Types that render at 16–32 px come from the small mark.
const smallTypes = new Set(['is32', 's8mk', 'il32', 'l8mk', 'icp4', 'icp5', 'ic11']);
function readIcns(file) {
  const data = readFileSync(file);
  const chunks = [];
  for (let at = 8; at < data.length; at += data.readUInt32BE(at + 4)) {
    chunks.push({ type: data.toString('latin1', at, at + 4), bytes: data.subarray(at, at + data.readUInt32BE(at + 4)) });
  }
  return chunks;
}
const smallIcns = readIcns(join(small, 'icon.icns'));
const chunks = readIcns(join(large, 'icon.icns'))
  .map((chunk) => (smallTypes.has(chunk.type) ? smallIcns.find((other) => other.type === chunk.type) : chunk).bytes);
const icnsHeader = Buffer.from('icns\0\0\0\0', 'latin1');
const icns = Buffer.concat([icnsHeader, ...chunks]);
icns.writeUInt32BE(icns.length, 4);
writeFileSync(join(icons, 'icon.icns'), icns);

rmSync(work, { recursive: true, force: true });
console.log('Icons written to icons/.');
