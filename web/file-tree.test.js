import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './test-dom.js';
import { createFileTree } from './file-tree.js';

installDom();

// A fake workspace: folder path → entries. Listing a missing folder fails.
function setup(folders) {
  const container = document.createElement('ul');
  document.body.replaceChildren(container);
  const listed = [];
  const opened = [];
  const errors = [];
  const menus = [];
  const tree = createFileTree({
    menu: (target, position) => menus.push(target),
    container,
    list: async (path) => {
      listed.push(path);
      if (!folders[path]) throw new Error(`Cannot read ${path}`);
      const entries = folders[path].map((name) => ({ name: name.replace(/\/$/, ''), path: `${path}/${name.replace(/\/$/, '')}`, folder: name.endsWith('/') }));
      return { entries, omitted: path === '/w/big' ? 5 : 0 };
    },
    open: (path) => opened.push(path),
    report: (error) => errors.push(error.message),
  });
  const items = () => [...container.querySelectorAll('[role="treeitem"]')];
  const labels = () => items().map((item) => `${'  '.repeat(Number(item.getAttribute('aria-level') ?? 1) - 1)}${item.querySelector('.tree-name')?.textContent ?? item.textContent}`);
  const key = (name) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { tree, container, listed, opened, errors, menus, items, labels, key, settle };
}

const workspace = {
  '/w': ['docs/', 'big/', 'a.md', 'b.txt'],
  '/w/docs': ['deep/', 'guide.md'],
  '/w/docs/deep': ['x.md'],
  '/w/big': ['one.md'],
};

test('only the root is listed until a folder is expanded', async () => {
  const env = setup(workspace);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  assert.deepEqual(env.listed, ['/w']);
  assert.deepEqual(env.labels(), ['docs', 'big', 'a.md', 'b.txt']);
  const [docs] = env.items();
  assert.equal(docs.getAttribute('aria-expanded'), 'false');
  assert.equal(docs.getAttribute('aria-setsize'), '4');
  assert.equal(docs.getAttribute('aria-posinset'), '1');
  assert.equal(docs.getAttribute('tabindex'), '0', 'one row is in the tab order');
  docs.click();
  await env.settle();
  assert.deepEqual(env.labels(), ['docs', '  deep', '  guide.md', 'big', 'a.md', 'b.txt']);
  assert.equal(env.items()[0].getAttribute('aria-expanded'), 'true');
  env.items()[2].click();
  assert.deepEqual(env.opened, ['/w/docs/guide.md']);
  env.items()[0].click();
  await env.settle();
  assert.deepEqual(env.labels(), ['docs', 'big', 'a.md', 'b.txt']);
});

test('the keyboard moves, expands, collapses, opens and finds by typing', async () => {
  const env = setup(workspace);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  env.tree.focus();
  assert.equal(document.activeElement.textContent, 'docs');
  env.key('ArrowRight');
  await env.settle();
  assert.equal(env.labels()[1], '  deep');
  env.key('ArrowRight');
  assert.equal(document.activeElement.textContent, 'deep', 'Right on an open folder enters it');
  env.key('ArrowDown');
  assert.equal(document.activeElement.textContent, 'guide.md');
  env.key('Enter');
  assert.deepEqual(env.opened, ['/w/docs/guide.md']);
  env.key('ArrowLeft');
  assert.equal(document.activeElement.textContent, 'docs', 'Left on a file goes to its folder');
  env.key('ArrowLeft');
  await env.settle();
  assert.deepEqual(env.labels(), ['docs', 'big', 'a.md', 'b.txt']);
  env.key('End');
  assert.equal(document.activeElement.textContent, 'b.txt');
  env.key('Home');
  env.key('b');
  assert.equal(document.activeElement.textContent, 'big');
  env.key('.');
  assert.equal(document.activeElement.textContent, 'b.txt', 'typing continues the name');
  await new Promise((resolve) => setTimeout(resolve, 750));
  env.key('a');
  assert.equal(document.activeElement.textContent, 'a.md', 'a pause starts a new search, wrapping around');
});

test('reveal expands the folders above a file; marks show current, open and unsaved files', async () => {
  const env = setup(workspace);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  await env.tree.reveal('/w/docs/deep/x.md');
  assert.deepEqual(env.labels(), ['docs', '  deep', '    x.md', '  guide.md', 'big', 'a.md', 'b.txt']);
  await env.tree.reveal('/elsewhere/y.md');
  env.tree.setMarks({ current: '/w/docs/deep/x.md', open: new Set(['/w/docs/deep/x.md', '/w/a.md']), dirty: new Set(['/w/a.md']) });
  const x = env.items()[2];
  assert.equal(x.getAttribute('aria-current'), 'true');
  const a = env.items().find((item) => item.dataset.path === '/w/a.md');
  assert.ok(a.classList.contains('open'));
  assert.equal(a.textContent, 'a.md●, unsaved changes');
  assert.equal(env.items()[0].getAttribute('aria-current'), null);
});

test('large folders say how many entries are not shown', async () => {
  const env = setup(workspace);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  env.items()[1].click();
  await env.settle();
  const note = env.items()[3];
  assert.equal(note.textContent, '5 more not shown');
  assert.equal(note.getAttribute('aria-disabled'), 'true');
  note.click();
  assert.deepEqual(env.opened, []);
});

test('refresh lists expanded folders again and drops ones that disappeared', async () => {
  const folders = structuredClone(workspace);
  const env = setup(folders);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  env.items()[0].click();
  await env.settle();
  folders['/w'] = ['docs/', 'c.md'];
  folders['/w/docs'] = ['new.md'];
  await env.tree.refresh();
  assert.deepEqual(env.labels(), ['docs', '  new.md', 'c.md']);
  delete folders['/w/docs'];
  await env.tree.refresh();
  assert.deepEqual(env.labels(), ['docs', 'c.md']);
  assert.equal(env.items()[0].getAttribute('aria-expanded'), 'false');
  delete folders['/w'];
  await env.tree.refresh();
  assert.match(env.container.textContent, /cannot be read/);
});

test('an unreadable folder is reported and stays collapsed; no workspace shows nothing', async () => {
  const env = setup({ '/w': ['locked/', 'a.md'] });
  await env.tree.setRoot({ path: '/w', name: 'w' });
  env.items()[0].click();
  await env.settle();
  assert.deepEqual(env.errors, ['Cannot read /w/locked']);
  assert.equal(env.items()[0].getAttribute('aria-expanded'), 'false');
  await env.tree.setRoot(null);
  assert.equal(env.items().length, 0);
  assert.equal(env.tree.root, null);
});

test('the context menu names the row, its folder, or the workspace; new items go in the right folder', async () => {
  const env = setup(workspace);
  await env.tree.setRoot({ path: '/w', name: 'w' });
  assert.equal(env.tree.folderForNew(), '/w', 'with nothing chosen, new items go in the workspace');
  await env.tree.expand('/w/docs');
  const guide = env.items().find((item) => item.dataset.path === '/w/docs/guide.md');
  guide.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.deepEqual(env.menus.at(-1), { path: '/w/docs/guide.md', folder: false, parent: '/w/docs' });
  assert.equal(env.tree.folderForNew(), '/w/docs', 'a file selects its folder');
  env.tree.select('/w/docs/deep', { focus: true });
  assert.equal(env.tree.folderForNew(), '/w/docs/deep');
  env.key('ContextMenu');
  assert.deepEqual(env.menus.at(-1), { path: '/w/docs/deep', folder: true, parent: '/w/docs' });
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(env.menus.length, 3);
  env.container.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.deepEqual(env.menus.at(-1), { path: '/w', folder: true, parent: null }, 'empty space means the workspace');
  await env.tree.setRoot(null);
  assert.equal(env.tree.folderForNew(), null);
});
