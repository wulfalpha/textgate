// The open documents of one window, in tab order, and which one is shown.
// Nothing here touches the DOM or CodeMirror: a tab is a plain object whose
// fields (path, editor state, saved baseline, file handle) belong to the app.
export function createTabs() {
  const tabs = [];
  let active = null;
  let nextId = 1;
  let nextUntitled = 1;
  const index = (tab) => {
    const at = tabs.indexOf(tab);
    if (at === -1) throw new Error('Not an open tab.');
    return at;
  };
  return {
    get list() { return [...tabs]; },
    get active() { return active; },
    get size() { return tabs.length; },
    // Adds after the active tab, as browsers do for tabs opened from a page.
    add(fields, { activate = true } = {}) {
      const tab = { ...fields, id: nextId++, untitled: fields.path ? null : nextUntitled++ };
      tabs.splice(active ? index(active) + 1 : tabs.length, 0, tab);
      if (activate || !active) active = tab;
      return tab;
    },
    activate(tab) { index(tab); active = tab; return tab; },
    // Returns the tab shown next: the right-hand neighbour, else the left.
    close(tab) {
      const at = index(tab);
      tabs.splice(at, 1);
      if (active === tab) active = tabs[Math.min(at, tabs.length - 1)] ?? null;
      return active;
    },
    // Wraps around at either end.
    step(offset) {
      if (!active) return null;
      return tabs[(index(active) + offset + tabs.length * Math.abs(offset)) % tabs.length];
    },
    // 1-based, as in Ctrl/Cmd+1 to 8; 9 is always the last tab.
    at(position) {
      return position === 9 ? tabs.at(-1) ?? null : tabs[position - 1] ?? null;
    },
    move(tab, to) {
      tabs.splice(index(tab), 1);
      tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
    },
    // Exact path match; Rust decides whether two paths are the same file.
    withPath(path) { return tabs.find((tab) => tab.path === path) ?? null; },
  };
}

const parts = (path) => path.split(/[\\/]/).filter(Boolean);
export const fileName = (path) => (path ? parts(path).at(-1) : 'Untitled.md');

// Labels for the tab bar. Files that share a name get as many parent folders
// as it takes to tell them apart (`notes.md — work`). Untitled tabs keep the
// number they were created with, so closing one does not rename the others.
export function tabLabels(tabs) {
  const labels = new Map();
  const groups = new Map();
  for (const tab of tabs) {
    const name = fileName(tab.path);
    const key = tab.path ? name : '';
    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }
  for (const [key, group] of groups) {
    if (!key) {
      for (const tab of group) labels.set(tab, (tab.untitled ?? 1) > 1 ? `Untitled-${tab.untitled}.md` : 'Untitled.md');
      continue;
    }
    if (group.length === 1) { labels.set(group[0], key); continue; }
    const folders = group.map((tab) => parts(tab.path).slice(0, -1).reverse());
    for (const [i, tab] of group.entries()) {
      let depth = 1;
      const suffix = () => folders[i].slice(0, depth).reverse().join('/');
      while (depth < folders[i].length && group.some((_, j) => j !== i && folders[j].slice(0, depth).reverse().join('/') === suffix())) depth++;
      labels.set(tab, suffix() ? `${key} — ${suffix()}` : key);
    }
  }
  return labels;
}
