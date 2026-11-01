import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function readVersions(root = new URL('../', import.meta.url)) {
  const read = (name) => readFileSync(new URL(name, root), 'utf8');
  const json = (name) => JSON.parse(read(name));
  const lock = json('package-lock.json');
  const cargo = read('Cargo.toml').split(/(?=^\[)/m).find((block) => block.startsWith('[package]'));
  const cargoLock = read('Cargo.lock').split('[[package]]').find((block) => /^name = "textgate"$/m.test(block));
  const version = (block) => block?.match(/^version = "([^"]+)"$/m)?.[1];
  return {
    'package.json': json('package.json').version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'Cargo.toml': version(cargo),
    'Cargo.lock (textgate)': version(cargoLock),
    'tauri.conf.json': json('tauri.conf.json').version,
  };
}

export function checkVersions(versions, tag = '') {
  const expected = versions['package.json'];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(expected ?? '')) {
    throw new Error('package.json must contain a release version.');
  }
  const errors = Object.entries(versions)
    .filter(([, value]) => value !== expected)
    .map(([name, value]) => `${name}: expected ${expected}, found ${value ?? 'no version'}`);
  if (tag && tag !== `v${expected}`) errors.push(`tag: expected v${expected}, found ${tag}`);
  if (errors.length) throw new Error(errors.join('\n'));
  return expected;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const version = checkVersions(readVersions(), process.env.RELEASE_TAG);
    console.log(`Version ${version} is consistent across manifests and lockfiles${process.env.RELEASE_TAG ? ` and matches ${process.env.RELEASE_TAG}` : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
