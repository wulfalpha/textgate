import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabs, tabLabels, fileName } from './tabs.js';

const names = (tabs) => tabs.list.map((tab) => tab.name);

test('tabs open after the active one, and closing shows the right-hand neighbour', () => {
  const tabs = createTabs();
  assert.equal(tabs.active, null);
  const a = tabs.add({ name: 'a' });
  const c = tabs.add({ name: 'c' });
  tabs.activate(a);
  const b = tabs.add({ name: 'b' });
  assert.deepEqual(names(tabs), ['a', 'b', 'c']);
  assert.equal(tabs.active, b);
  tabs.add({ name: 'background' }, { activate: false });
  assert.equal(tabs.active, b, 'a background tab does not take focus');
  assert.deepEqual(names(tabs), ['a', 'b', 'background', 'c']);
  assert.ok(new Set(tabs.list.map((tab) => tab.id)).size === 4, 'ids are unique');

  assert.equal(tabs.close(b).name, 'background');
  assert.equal(tabs.close(c), tabs.active, 'closing an inactive tab keeps the active one');
  assert.equal(tabs.active.name, 'background');
  tabs.activate(tabs.list.at(-1));
  assert.equal(tabs.close(tabs.active), a, 'the last tab falls back to its left');
  assert.equal(tabs.close(a), null);
  assert.equal(tabs.size, 0);
  assert.throws(() => tabs.activate(a), /Not an open tab/);
  assert.throws(() => tabs.close(a), /Not an open tab/);
});

test('stepping wraps, positions 1-8 are direct and 9 is the last tab', () => {
  const tabs = createTabs();
  assert.equal(tabs.step(1), null);
  const [a, b, c] = ['a', 'b', 'c'].map((name) => tabs.add({ name }));
  assert.equal(tabs.active, c);
  assert.equal(tabs.step(1), a);
  assert.equal(tabs.step(-1), b);
  tabs.activate(a);
  assert.equal(tabs.step(-1), c);
  assert.equal(tabs.at(1), a);
  assert.equal(tabs.at(2), b);
  assert.equal(tabs.at(5), null);
  assert.equal(tabs.at(9), c);
  tabs.move(c, 0);
  assert.deepEqual(names(tabs), ['c', 'a', 'b']);
  tabs.move(c, 99);
  assert.deepEqual(names(tabs), ['a', 'b', 'c']);
  assert.equal(tabs.withPath('/x'), null);
  const x = tabs.add({ name: 'x', path: '/x' });
  assert.equal(tabs.withPath('/x'), x);
});

test('labels name files, tell same-named files apart by folder and number Untitled tabs', () => {
  const tabs = createTabs();
  const add = (path) => tabs.add({ path });
  const first = add(null);
  const work = add('/home/me/work/notes.md');
  const home = add('/home/me/notes.md');
  const deep = [add('/a/x/docs/readme.md'), add('/b/x/docs/readme.md')];
  const windows = add('C:\\Users\\me\\todo.md');
  const second = add(null);
  const third = add(null);
  let labels = tabLabels(tabs.list);
  assert.equal(labels.get(first), 'Untitled.md');
  assert.equal(labels.get(second), 'Untitled-2.md');
  assert.equal(labels.get(third), 'Untitled-3.md');
  assert.equal(labels.get(work), 'notes.md — work');
  assert.equal(labels.get(home), 'notes.md — me');
  assert.deepEqual(deep.map((tab) => labels.get(tab)), ['readme.md — a/x/docs', 'readme.md — b/x/docs']);
  assert.equal(labels.get(windows), 'todo.md');
  tabs.close(second);
  tabs.close(home);
  labels = tabLabels(tabs.list);
  assert.equal(labels.get(third), 'Untitled-3.md', 'numbers stay with their tab');
  assert.equal(labels.get(work), 'notes.md', 'no folder once the name is unique');
  assert.equal(fileName(null), 'Untitled.md');
  assert.equal(fileName('/x/y.md'), 'y.md');
});
