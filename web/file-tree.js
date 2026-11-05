// The workspace file tree: one row per visible folder or file, as an ARIA tree
// (`role="tree"` with `treeitem`s carrying their level, size and position).
// Folders are listed when first expanded, so large trees stay fast.
//
// - `list(path)` resolves to `{ entries: [{ name, path, folder }], omitted }`.
// - `open(path)` opens a file (in a tab).
// - `menu(target, { x, y })` shows a context menu for `{ path, folder, parent }`
//   (the workspace itself when no row was chosen).
// - `command(name, target)` runs `rename` (F2) or `trash` (Delete) on a row.
// - `expanded(paths)` is told which folders are open, to remember them.
export function createFileTree({ container, list, open, report, menu = () => {}, command = () => {}, expanded: remember = () => {} }) {
  const document = container.ownerDocument;
  let root = null;
  let failure = null;
  const listings = new Map();
  const expanded = new Set();
  let selected = null;
  let marks = { current: null, open: new Set(), dirty: new Set() };
  let typed = '';
  let typedAt = 0;
  let generation = 0;

  const separator = () => (root.path.includes('\\') && !root.path.includes('/') ? '\\' : '/');
  function rows() {
    const out = [];
    const walk = (folder, level) => {
      const listing = listings.get(folder);
      if (!listing) return;
      listing.entries.forEach((entry, i) => {
        out.push({ ...entry, level, position: i + 1, size: listing.entries.length });
        if (entry.folder && expanded.has(entry.path)) walk(entry.path, level + 1);
      });
      if (listing.omitted) out.push({ note: true, path: `${folder}\0more`, name: `${listing.omitted} more not shown`, level });
    };
    if (root) walk(root.path, 1);
    return out;
  }

  function element(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) if (value !== undefined) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }
  let remembered = '';
  function render() {
    const paths = JSON.stringify([...expanded]);
    if (root && paths !== remembered) { remembered = paths; remember([...expanded]); }
    const focused = container.contains(document.activeElement);
    const visible = rows();
    // Until a row is chosen, the first one is where the keyboard enters.
    if (!visible.some((row) => row.path === selected)) selected = null;
    const entry = selected ?? visible[0]?.path;
    container.replaceChildren(...visible.map((row) => {
      const changed = marks.dirty.has(row.path);
      return element('li', {
        role: 'treeitem', 'data-path': row.path, 'aria-level': String(row.level),
        'aria-setsize': row.note ? undefined : String(row.size), 'aria-posinset': row.note ? undefined : String(row.position),
        'aria-expanded': row.folder ? String(expanded.has(row.path)) : undefined,
        'aria-disabled': row.note ? 'true' : undefined,
        'aria-current': row.path === marks.current ? 'true' : undefined,
        tabindex: row.path === entry ? '0' : '-1',
        class: [row.folder ? 'folder' : row.note ? 'note' : 'file', marks.open.has(row.path) ? 'open' : ''].filter(Boolean).join(' '),
        style: `--level: ${row.level}`,
      },
      element('span', { class: 'tree-name' }, row.name),
      ...(changed ? [element('span', { class: 'tree-dirty', 'aria-hidden': 'true' }, '●'), element('span', { class: 'visually-hidden' }, ', unsaved changes')] : []));
    }));
    if (failure) container.append(element('li', { role: 'treeitem', 'aria-disabled': 'true', class: 'note', tabindex: visible.length ? '-1' : '0' }, failure));
    if (focused) focusSelected();
  }
  function focusSelected() {
    (container.querySelector('[tabindex="0"]') ?? container).focus();
  }

  // Lists a folder; a failure leaves the folder collapsed and is reported.
  async function load(folder) {
    try {
      listings.set(folder, await list(folder));
      return true;
    } catch (error) {
      listings.delete(folder);
      expanded.delete(folder);
      report(error);
      return false;
    }
  }
  async function setExpanded(path, value) {
    if (value) {
      if (!await load(path)) { render(); return; }
      expanded.add(path);
    } else expanded.delete(path);
    render();
  }

  // The folder a row is in: the nearest row above it at a lower level.
  function parentOf(path, visible = rows()) {
    const at = visible.findIndex((row) => row.path === path);
    return visible.slice(0, Math.max(at, 0)).findLast((row) => row.level < visible[at]?.level)?.path ?? root.path;
  }
  function targetOf(path) {
    const row = rows().find((candidate) => candidate.path === path && !candidate.note);
    return row ? { path: row.path, folder: row.folder, parent: parentOf(row.path) } : { path: root.path, folder: true, parent: null };
  }
  container.addEventListener('focusin', (event) => {
    const row = event.target.closest?.('[role="treeitem"][data-path]');
    if (row && row.getAttribute('aria-disabled') !== 'true') selected = row.dataset.path;
  });
  container.addEventListener('contextmenu', (event) => {
    if (!root) return;
    event.preventDefault();
    const row = event.target.closest('[role="treeitem"][data-path]');
    if (row && row.getAttribute('aria-disabled') !== 'true') { selected = row.dataset.path; render(); }
    menu(targetOf(row?.dataset.path), { x: event.clientX, y: event.clientY });
  });
  container.addEventListener('click', (event) => {
    const row = event.target.closest('[role="treeitem"][data-path]');
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const path = row.dataset.path;
    selected = path;
    if (row.classList.contains('folder')) void setExpanded(path, !expanded.has(path));
    // A click opens the file but keeps focus here, as in Finder, so F2 and
    // Delete/Cmd+Backspace act on the row just clicked.
    else { render(); open(path, { focus: false }); }
  });
  container.addEventListener('keydown', (event) => {
    const chosen = rows().some((row) => row.path === selected && !row.note);
    // Delete, or Cmd+Backspace as in the macOS Finder.
    const trash = event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey);
    if (chosen && (event.key === 'F2' || trash) && !event.ctrlKey && !event.altKey) {
      command(trash ? 'trash' : 'rename', targetOf(selected));
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const visible = rows();
    const at = visible.findIndex((row) => row.path === selected);
    const row = visible[at];
    const select = (target) => { if (target) { selected = target.path; render(); focusSelected(); } };
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const box = container.querySelector('[tabindex="0"]')?.getBoundingClientRect();
      menu(targetOf(selected), { x: box ? box.left + 16 : 0, y: box ? box.bottom : 0 });
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'ArrowDown': select(visible[at + 1]); break;
      case 'ArrowUp': select(visible[at - 1]); break;
      case 'Home': select(visible[0]); break;
      case 'End': select(visible.at(-1)); break;
      case 'ArrowRight':
        if (row?.folder && !expanded.has(row.path)) void setExpanded(row.path, true);
        else if (row?.folder) select(visible[at + 1]?.level > row.level ? visible[at + 1] : null);
        break;
      case 'ArrowLeft':
        if (row?.folder && expanded.has(row.path)) void setExpanded(row.path, false);
        else select(visible.slice(0, Math.max(at, 0)).findLast((candidate) => candidate.level < (row?.level ?? 0)));
        break;
      case 'Enter':
        if (row?.folder) void setExpanded(row.path, !expanded.has(row.path));
        // Enter opens the file and moves into it, ready to type.
        else if (row && !row.note) open(row.path, { focus: true });
        break;
      default: {
        // Type-ahead: jump to the next name starting with the typed letters.
        if (event.key.length !== 1 || event.key === ' ') return;
        const now = Date.now();
        typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
        typedAt = now;
        const order = [...visible.slice(at + (typed.length > 1 ? 0 : 1)), ...visible.slice(0, at + 1)];
        select(order.find((candidate) => !candidate.note && candidate.name.toLowerCase().startsWith(typed)));
      }
    }
    event.preventDefault();
  });

  return {
    get root() { return root; },
    // Shows a workspace (`{ path, name }`), or nothing, reopening the folders
    // given in `open` that still exist (parents before children).
    async setRoot(workspace, { open = [] } = {}) {
      const run = ++generation;
      root = workspace;
      failure = null;
      listings.clear();
      expanded.clear();
      selected = null;
      // An unreadable folder does not forget which folders were open.
      remembered = '[]';
      if (root && !await load(root.path) && run === generation) failure = 'This folder cannot be read. It may have been moved or deleted.';
      if (root && !failure) {
        const sep = separator();
        const visible = (path) => listings.get(path.slice(0, path.lastIndexOf(sep)) || root.path)?.entries.some((entry) => entry.folder && entry.path === path);
        for (const path of [...open].sort((a, b) => a.length - b.length)) {
          if (run !== generation) return;
          if (!visible(path)) continue;
          try { listings.set(path, await list(path)); expanded.add(path); } catch { /* gone or unreadable: stays closed */ }
        }
        if (run === generation) remembered = JSON.stringify([...expanded]);
      }
      if (run === generation) render();
    },
    // Lists the workspace and every expanded folder again.
    async refresh() {
      if (!root) return;
      const run = ++generation;
      const folders = [root.path, ...expanded];
      const results = await Promise.all(folders.map(async (folder) => {
        try { return [folder, await list(folder)]; } catch { return [folder, null]; }
      }));
      if (run !== generation) return;
      for (const [folder, listing] of results) {
        if (listing) listings.set(folder, listing);
        else { listings.delete(folder); expanded.delete(folder); }
      }
      failure = listings.has(root.path) ? null : 'This folder cannot be read. It may have been moved or deleted.';
      render();
    },
    // Expands the folders above a file inside the workspace, so it is visible.
    async reveal(path) {
      if (!root || !path) return;
      const sep = separator();
      const prefix = root.path.endsWith(sep) ? root.path : root.path + sep;
      if (!path.startsWith(prefix)) return;
      const parts = path.slice(prefix.length).split(sep).slice(0, -1);
      let folder = root.path;
      for (const part of parts) {
        folder = folder.endsWith(sep) ? folder + part : folder + sep + part;
        if (!expanded.has(folder) && !await load(folder)) return;
        expanded.add(folder);
      }
      render();
    },
    // The active tab's file, files open in tabs, and those with unsaved changes.
    setMarks(next) {
      const same = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));
      if (next.current === marks.current && same(next.open, marks.open) && same(next.dirty, marks.dirty)) return;
      marks = next;
      render();
    },
    focus: focusSelected,
    // Where new files go: the selected folder, else the selected file's folder.
    folderForNew() {
      if (!root) return null;
      const target = targetOf(selected);
      return target.folder ? target.path : target.parent;
    },
    // After a rename: expanded folders, listings and the selection follow it.
    moved(from, to) {
      const sep = separator();
      const follow = (path) => (path === from ? to : path.startsWith(from + sep) ? to + path.slice(from.length) : path);
      for (const path of [...expanded]) { expanded.delete(path); expanded.add(follow(path)); }
      for (const [path, listing] of [...listings]) {
        listings.delete(path);
        listings.set(follow(path), { ...listing, entries: listing.entries.map((entry) => ({ ...entry, path: follow(entry.path) })) });
      }
      if (selected) selected = follow(selected);
      if (marks.current) marks = { ...marks, current: follow(marks.current) };
      render();
    },
    async expand(path) {
      if (root && path !== root.path && !expanded.has(path)) await setExpanded(path, true);
    },
    // Selects a visible row, keeping focus where it is unless asked.
    select(path, { focus = false } = {}) {
      if (!rows().some((row) => row.path === path)) return;
      selected = path;
      render();
      if (focus) focusSelected();
    },
  };
}
