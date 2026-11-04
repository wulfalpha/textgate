import { setupThemes } from './themes.js';
import { setupMenus, appDialogOpen } from './menus.js';
import packageInfo from '../package.json' with { type: 'json' };
import { syntaxHighlighting } from '@codemirror/language';
import { fencedLanguage } from './source-language.js';
import { indentWithTab, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { fullHeightVimCursor } from './vim-cursor.js';
import { defineVimFileCommands } from './vim-commands.js';
import { spellcheck, readSpellcheck, storeSpellcheck } from './spellcheck.js';
import createDOMPurify from 'dompurify';
import { listen } from '@tauri-apps/api/event';
import { createDocumentOpener } from './document-opener.js';
import { setupExternalOpen } from './external-open.js';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save, confirm, message as messageDialog } from '@tauri-apps/plugin-dialog';
import { createDocumentStore } from './document-store.js';
import { createTabs, fileName, tabLabels } from './tabs.js';
import { createFileTree } from './file-tree.js';
import { createActionRunner } from './action-runner.js';
import { encodeDocument, defaultFormat, lineEndingLabel, documentFormat, preserveDocumentFormat, sameDocumentFormat, normalizeLineEndings, snapshotDocument } from './document-format.js';
import { createRenderer } from './markdown.js';
import { createDocumentDetails, updateOutline, detailsDelay, largeDocument } from './document-details.js';
import { livePreview } from './live-preview.js';
import { relativeLineNumbers } from './line-numbers.js';
import { createZoom } from './zoom.js';
import { textDirection } from './text-direction.js';
import * as format from './markdown-commands.js';
const DOMPurify = createDOMPurify(window);
const render = createRenderer({ desktop: isTauri(), invoke, purifier: DOMPurify });
const documents = createDocumentStore({ invoke, confirmOverwrite: (destination, missing) => confirm(
  missing
    ? `The file was deleted or moved outside Textgate:\n${destination}\n\nRecreate it with your editor contents?`
    : `The file changed outside Textgate:\n${destination}\n\nOverwrite it with your editor contents? Cancel keeps both versions unchanged; use Save As to keep a separate copy.`,
  { title: 'File changed on disk', kind: 'warning', okLabel: missing ? 'Recreate' : 'Overwrite', cancelLabel: 'Cancel' },
) });
// Each tab holds its path, its Rust document handle and the version last opened
// or saved. The shown tab's editor state lives in the view; others keep theirs.
const tabs = createTabs();

const $ = (id) => document.getElementById(id);
const initial = '# Welcome to Textgate\n\nA quiet place to write Markdown.\n\n## Start writing\n\nOpen a document or create a new one. Your preview updates as you type.\n\n- **Bold**, *italic*, and ~~strikethrough~~\n- Keyboard-friendly editing\n- Optional Vim keybindings\n- [x] Your Markdown is never rewritten\n\n## Tables\n\n| Feature | Status |\n| --- | --- |\n| Live preview | Ready |\n| GFM tables | Ready |\n\n```rust\nfn main() {\n    println!("Hello, Textgate!");\n}\n```\n';
let vimEnabled = false;
let relativeNumbers = false;
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
let spellchecking = readSpellcheck(storage);
let mode = 'live';
let nativeMenus = null;
let title = '';
let detailsTimer = null;
let previewVersion = 0;
let previewRenderedDoc = null;
let previewBusy = false;
let previewPromise = null;
const details = createDocumentDetails();
const vimMode = new Compartment();
const numbersMode = new Compartment();
const spellcheckMode = new Compartment();
const liveMode = new Compartment();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const view = new EditorView({
  parent: $('editor'),
  state: EditorState.create({ doc: initial, extensions: extensions() }),
});
tabs.add({ path: null, file: documents.create(), savedDoc: view.state.doc, savedFormat: view.state.field(documentFormat) });
// Start ready to type. Platform spell checkers also begin checking an editable
// region only once it has focus.
view.focus();
const stateOf = (tab) => (tab === tabs.active ? view.state : tab.state);
// Cached per tab, so typing does not compare every open document each keystroke.
function dirty(tab = tabs.active) {
  // A file moved to the trash: its tab keeps the text until saved again.
  if (tab.deleted) return true;
  const state = stateOf(tab);
  const memo = tab.dirtyMemo;
  if (memo?.state === state && memo.savedDoc === tab.savedDoc && memo.savedFormat === tab.savedFormat) return memo.value;
  const value = !state.doc.eq(tab.savedDoc) || !sameDocumentFormat(state.field(documentFormat), tab.savedFormat, state.doc);
  tab.dirtyMemo = { state, savedDoc: tab.savedDoc, savedFormat: tab.savedFormat, value };
  return value;
}
// A blank Untitled tab (including the welcome text) that a newly opened file replaces.
const pristine = (tab) => !tab.path && !dirty(tab);
const name = () => fileName(tabs.active.path);
const previewVisible = () => mode === 'source' && $('toggle-preview').getAttribute('aria-pressed') === 'true';

function refresh() {
  updateEditorStatus();
  renderTabs();
  const changed = dirty();
  $('filename').textContent = name();
  // Screen readers ignore aria-label on a plain span; give them real text.
  $('dirty').replaceChildren(...(changed ? [Object.assign(document.createElement('span'), { textContent: '●', ariaHidden: 'true' }),
    Object.assign(document.createElement('span'), { className: 'visually-hidden', textContent: 'Unsaved changes' })] : []));
  const next = `${changed ? '• ' : ''}${name()} — Textgate`;
  if (next !== title) {
    title = document.title = next;
    if (isTauri()) getCurrentWindow().setTitle(title).catch(report);
  }
  // Outline, statistics and preview are derived views; batch them while typing.
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(refreshDetails, detailsDelay(view.state.doc.length));
}
async function refreshDetails() {
  clearTimeout(detailsTimer);
  const doc = view.state.doc;
  // Preview need not wait for word counting or outline parsing.
  const preview = refreshPreview();
  try {
    const result = await details.get(doc);
    if (result && view.state.doc === doc) {
      updateOutline($('outline'), result.headings, (offset) => {
        view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) });
        view.focus();
      });
      $('stats').textContent = `${result.words} words · ${doc.lines} lines · ${lineEndingLabel(view.state.field(documentFormat))}`;
    }
  } catch (error) { if (view.state.doc === doc) report(error); }
  return preview;
}
function previewNote(message) {
  $('preview-note').textContent = message;
  $('preview-note').hidden = !message;
}
async function refreshPreview(force = false) {
  if (!previewVisible()) return;
  const doc = view.state.doc;
  if (previewRenderedDoc === doc) { previewNote(''); return; }
  if (doc.length >= largeDocument && !force) {
    previewNote('Large document: preview updates on request. Choose Refresh to show your latest edits.');
    return;
  }
  if (previewBusy) {
    await previewPromise.catch(() => {});
    return refreshPreview(force);
  }
  const version = previewVersion;
  previewBusy = true;
  $('refresh-preview').disabled = true;
  previewNote('Updating preview…');
  try {
    previewPromise = render(doc.toString());
    const fragment = await previewPromise;
    // Invalidate on edits immediately, even before the debounce timer fires.
    if (version === previewVersion && doc === view.state.doc && previewVisible()) {
      $('preview').replaceChildren(fragment);
      previewRenderedDoc = doc;
      previewNote('');
    }
  } catch (error) { if (version === previewVersion) { previewNote('Preview could not be updated. Choose Refresh to retry.'); report(error); } }
  finally {
    previewBusy = false;
    $('refresh-preview').disabled = false;
  }
}
function documentChanged() {
  previewVersion++;
  details.invalidate(view.state.doc);
  if (view.state.doc.length >= largeDocument) previewNote('Large document: preview updates on request. Choose Refresh to show your latest edits.');
  refresh();
}
function report(error) { $('status').textContent = `Error: ${error.message ?? error}`; }
function askDiscard(message, okLabel = 'Discard') {
  return isTauri()
    ? confirm(message, { title: 'Textgate', kind: 'warning', okLabel, cancelLabel: 'Cancel' })
    : Promise.resolve(window.confirm(message));
}
// Closing one tab with unsaved changes: Save, Don't Save or Cancel. The browser
// fallback has only OK/Cancel, so it offers to discard.
async function askSave(tab) {
  const label = fileName(tab.path);
  if (!isTauri()) return window.confirm(`Discard unsaved changes to ${label}?`) ? 'discard' : 'cancel';
  const answer = await messageDialog(`Save changes to ${label} before closing?`, {
    title: 'Textgate', kind: 'warning', buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
  });
  // Platforms report either the button's role or its label.
  if (answer === 'Yes' || answer === 'Save') return 'save';
  if (answer === 'No' || answer === "Don't Save") return 'discard';
  return 'cancel';
}
// Asks until the answer covers the latest edits: typing can continue while a
// native confirmation is on screen, and approval must not discard that too.
async function approveDiscard(list, message, okLabel) {
  while (true) {
    const changed = list.filter((tab) => tabs.list.includes(tab) && dirty(tab));
    if (!changed.length) return true;
    const before = changed.map((tab) => snapshotDocument(stateOf(tab)));
    if (!await askDiscard(message(changed), okLabel)) return false;
    if (changed.every((tab, i) => tabs.list.includes(tab) && snapshotDocument(stateOf(tab)).eq(before[i]))) return true;
  }
}
const approveQuit = () => approveDiscard(tabs.list, (changed) => (changed.length === 1
  ? `Discard unsaved changes to ${fileName(changed[0].path)}?`
  : `Discard unsaved changes in ${changed.length} documents?\n\n${changed.map((tab) => fileName(tab.path)).join('\n')}`), 'Quit Without Saving');

// Shows a tab's stored editor state. Settings are global, so the state's
// compartments are brought up to date; Vim starts again in Normal mode.
function load(tab, { focus = true } = {}) {
  const { state, scroll } = tab;
  tab.state = tab.scroll = null;
  view.setState(state);
  view.dispatch({ effects: [
    vimMode.reconfigure(vimEnabled ? vimExtensions() : []),
    numbersMode.reconfigure(relativeNumbers ? relativeLineNumbers() : []),
    spellcheckMode.reconfigure(spellchecking ? spellcheck() : []),
    liveMode.reconfigure(mode === 'live' ? livePreview({ render }) : []),
    ...(scroll ? [scroll] : []),
  ] });
  previewRenderedDoc = null;
  $('preview').replaceChildren();
  delete $('outline').dataset.outlineLimit;
  documentChanged();
  updateToolbar();
  if (focus) view.focus();
}
function showTab(tab, options) {
  const current = tabs.active;
  if (tab === current) { if (options?.focus !== false) view.focus(); return; }
  current.state = view.state;
  current.scroll = view.scrollSnapshot();
  tabs.activate(tab);
  load(tab, options);
}
// Each document has its own state, so undo history stays with its tab.
function addTab({ text = '', path = null, format = defaultFormat, file = documents.create() } = {}) {
  const state = EditorState.create({ doc: text, extensions: extensions(format) });
  const tab = tabs.add({ path, file, state, savedDoc: state.doc, savedFormat: state.field(documentFormat) }, { activate: false });
  showTab(tab);
  return tab;
}
// A newly opened file takes the place of a blank Untitled tab.
function place(opened) {
  const blank = tabs.active;
  const reuse = pristine(blank);
  const tab = addTab(opened);
  if (reuse) discardTab(blank);
  return tab;
}
// Closes without asking; an empty Untitled tab replaces the last one.
function discardTab(tab) {
  if (tabs.size === 1) addTab();
  const shown = tab === tabs.active;
  const next = tabs.close(tab);
  tab.file.close().catch(report);
  if (shown) load(next);
  refresh();
}
// Asks again if the tab changes while the question is open, so later edits are
// never discarded unseen; a cancelled or failed save keeps the tab open.
async function closeTab(tab = tabs.active) {
  while (tabs.list.includes(tab) && dirty(tab)) {
    showTab(tab);
    const before = snapshotDocument(stateOf(tab));
    const choice = await askSave(tab);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      if (!await saveDocument(false, tab)) return false;
    } else if (snapshotDocument(stateOf(tab)).eq(before)) break;
  }
  if (tabs.list.includes(tab)) discardTab(tab);
  return true;
}
// The tab bar is rebuilt only when a label, unsaved marker or the active tab changes.
let tabBarKey = '';
function renderTabs() {
  const labels = tabLabels(tabs.list);
  const entries = tabs.list.map((tab) => ({ tab, label: labels.get(tab), changed: dirty(tab), active: tab === tabs.active }));
  const key = JSON.stringify(entries.map(({ tab, label, changed, active }) => [tab.id, label, tab.path, changed, active]));
  if (key === tabBarKey) return;
  tabBarKey = key;
  markFiles();
  const bar = $('tabbar');
  const focused = bar.contains(document.activeElement);
  const element = (tag, attributes, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  };
  bar.replaceChildren(...entries.map(({ tab, label, changed, active }) => element('div', { class: `tab-item${active ? ' active' : ''}`, role: 'presentation', 'data-tab': tab.id },
    element('button', { class: 'tab', role: 'tab', id: `tab-${tab.id}`, 'aria-selected': String(active), 'aria-controls': 'editor', tabindex: active ? '0' : '-1', title: tab.deleted ? `${tab.path} (moved to the trash; save to recreate)` : tab.path ?? 'Not saved yet' },
      element('span', { class: 'tab-label' }, label),
      ...(changed ? [element('span', { class: 'tab-dirty', 'aria-hidden': 'true' }, '●'), element('span', { class: 'visually-hidden' }, ', unsaved changes')] : [])),
    element('button', { class: 'tab-close', tabindex: '-1', 'aria-label': `Close ${label}`, title: 'Close tab' }, '×'))));
  const current = $(`tab-${tabs.active.id}`);
  if (focused) current.focus();
  current.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
const tabFor = (target) => tabs.list.find((tab) => String(tab.id) === target.closest('[data-tab]')?.dataset.tab);
$('tabbar').addEventListener('click', (event) => {
  const tab = tabFor(event.target);
  if (!tab) return;
  if (event.target.closest('.tab-close')) run(() => closeTab(tab));
  else showTab(tab);
});
// Middle-click closes, as in browsers.
$('tabbar').addEventListener('auxclick', (event) => {
  const tab = event.button === 1 && tabFor(event.target);
  if (tab) { event.preventDefault(); run(() => closeTab(tab)); }
});
$('tabbar').addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
// Arrow keys move between tabs and show each one; Delete closes; Enter or
// Escape returns to the editor.
$('tabbar').addEventListener('keydown', (event) => {
  const tab = tabFor(event.target);
  if (!tab) return;
  const list = tabs.list;
  const at = list.indexOf(tab);
  const target = { ArrowLeft: list[(at + list.length - 1) % list.length], ArrowRight: list[(at + 1) % list.length], Home: list[0], End: list.at(-1) }[event.key];
  if (target) {
    showTab(target, { focus: false });
    renderTabs();
    $(`tab-${target.id}`).focus();
  } else if (event.key === 'Delete') run(() => closeTab(tab));
  else if (['Enter', ' ', 'Escape'].includes(event.key)) { showTab(tab); view.focus(); }
  else return;
  event.preventDefault();
});
const mac = /Mac/.test(navigator.platform);
// Tab switching keys, as in browsers: Ctrl+Tab and Ctrl+PageDown/PageUp, plus
// Cmd+Shift+] / [ on macOS; Ctrl/Cmd+1-8 go to a tab and 9 to the last.
function tabShortcut(event) {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') return tabs.step(event.shiftKey ? -1 : 1);
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['PageDown', 'PageUp'].includes(event.key)) return tabs.step(event.key === 'PageDown' ? 1 : -1);
  if (mac && event.metaKey && event.shiftKey && !event.altKey && ['BracketRight', 'BracketLeft'].includes(event.code)) return tabs.step(event.code === 'BracketRight' ? 1 : -1);
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (mod && digit && !event.shiftKey && !event.altKey) return tabs.at(Number(digit[1])) ?? tabs.active;
  return null;
}
// The file browser: the workspace folder's Markdown and text files.
const fileTree = createFileTree({
  container: $('file-tree'),
  list: (path) => invoke('list_folder', { path }),
  open: (path) => run.enqueue(() => openFile(path)),
  report,
  menu: (target, position) => { showTreeMenu(target, position).catch(report); },
  command: (name, target) => run(() => (name === 'rename' ? renameEntry(target) : trashEntry(target))),
});
// Asks for a name in an app dialog. `submit(name)` may throw to show why and
// keep the dialog open; resolves with its result, or null if cancelled.
function askName({ title, label = 'Name', value = '', hint = '', action = 'Create', selection = null, submit }) {
  const dialog = $('name-dialog');
  $('name-title').textContent = title;
  $('name-label').textContent = label;
  $('name-hint').textContent = hint;
  $('name-submit').textContent = action;
  $('name-error').textContent = '';
  $('name-input').value = value;
  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      $('name-form').onsubmit = $('name-cancel').onclick = null;
      dialog.removeEventListener('close', cancelled);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const cancelled = () => done(null);
    $('name-form').onsubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      try { done(await submit($('name-input').value)); }
      catch (error) { $('name-error').textContent = error?.message ?? String(error); busy = false; }
    };
    $('name-cancel').onclick = cancelled;
    dialog.addEventListener('close', cancelled);
    dialog.showModal();
    $('name-input').focus();
    if (selection) $('name-input').setSelectionRange(...selection);
    else $('name-input').select();
  });
}
// A new empty file opens in a tab; a new folder is selected in the tree.
async function newEntry(kind, folder = fileTree.folderForNew()) {
  if (!folder) { $('status').textContent = 'Open a folder first.'; return; }
  const where = folder === fileTree.root.path ? fileTree.root.name : fileName(folder);
  const path = await askName({
    title: `New ${kind} in ${where}`,
    hint: kind === 'file' ? '.md is added unless the name ends in .md, .markdown or .txt.' : '',
    submit: (name) => invoke('create_entry', { folder, name, kind }),
  });
  if (!path) return;
  await fileTree.refresh();
  await fileTree.expand(folder);
  if (kind === 'file') await openFile(path);
  else fileTree.select(path, { focus: true });
  $('status').textContent = `Created ${fileName(path)}`;
}
const separatorOf = (path) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
// Tabs follow a renamed file or folder; Rust names the documents it moved
// (including tabs that reached a file through a linked folder).
async function renameEntry(target) {
  const current = fileName(target.path);
  const dot = target.folder ? -1 : current.lastIndexOf('.');
  const result = await askName({
    title: `Rename ${current}`,
    value: current,
    action: 'Rename',
    selection: dot > 0 ? [0, dot] : null,
    hint: target.folder ? 'Open files inside it keep their tabs.' : 'The extension is kept unless you type .md, .markdown or .txt.',
    submit: (name) => invoke('rename_entry', { path: target.path, name }),
  });
  if (!result || result.path === target.path) return;
  const from = target.path;
  const sep = separatorOf(from);
  const moved = new Set();
  for (const [id, path] of result.documents) {
    const tab = await tabWithDocument(id);
    if (tab) { tab.path = path; moved.add(tab); }
  }
  for (const tab of tabs.list) {
    if (moved.has(tab) || !tab.path) continue;
    if (tab.path === from) tab.path = result.path;
    else if (tab.path.startsWith(from + sep)) tab.path = result.path + tab.path.slice(from.length);
  }
  fileTree.moved(from, result.path);
  revealed = tabs.active.path;
  refresh();
  await fileTree.refresh();
  fileTree.select(result.path, { focus: true });
  $('status').textContent = `Renamed to ${fileName(result.path)}`;
}
// To the system trash, never deleted outright; open tabs keep their text.
async function trashEntry(target) {
  const label = fileName(target.path);
  const inside = tabs.list.filter((tab) => tab.path && (tab.path === target.path || tab.path.startsWith(target.path + separatorOf(target.path))));
  const note = inside.length ? `\n\n${inside.length === 1 ? 'Its open tab stays' : `${inside.length} open tabs stay`} open, so you can still save the text.` : '';
  const what = target.folder ? `the folder “${label}” and everything in it` : `“${label}”`;
  if (!await confirm(`Move ${what} to the trash?${note}`, { title: 'Move to Trash', kind: 'warning', okLabel: 'Move to Trash', cancelLabel: 'Cancel' })) return;
  const ids = await invoke('trash_entry', { path: target.path });
  for (const id of ids) {
    const tab = await tabWithDocument(id);
    if (tab) tab.deleted = true;
  }
  refresh();
  await fileTree.refresh();
  fileTree.focus();
  $('status').textContent = ids.length ? `Moved ${label} to the trash. Open tabs keep their text; save to recreate a file.` : `Moved ${label} to the trash.`;
}
// The context menu, built for the row it was opened on.
async function showTreeMenu(target, position) {
  if (!isTauri()) return;
  const folder = target.folder ? target.path : target.parent;
  const workspace = target.parent === null;
  const { Menu } = await import('@tauri-apps/api/menu');
  const treeMenu = await Menu.new({ items: [
    { text: 'New File…', action: () => run(() => newEntry('file', folder)) },
    { text: 'New Folder…', action: () => run(() => newEntry('folder', folder)) },
    { item: 'Separator' },
    { text: 'Rename…', accelerator: 'F2', enabled: !workspace, action: () => run(() => renameEntry(target)) },
    { text: 'Move to Trash…', enabled: !workspace, action: () => run(() => trashEntry(target)) },
    { item: 'Separator' },
    { text: 'Show in File Manager', action: () => { invoke('reveal_entry', { path: target.path }).catch(report); } },
    { text: 'Refresh', action: () => { fileTree.refresh().catch(report); } },
  ] });
  const { LogicalPosition } = await import('@tauri-apps/api/dpi');
  // Page coordinates scale with the window zoom.
  await treeMenu.popup(new LogicalPosition(position.x * zoom.level, position.y * zoom.level));
}
let revealed = null;
function markFiles() {
  const paths = tabs.list.filter((tab) => tab.path);
  fileTree.setMarks({
    current: tabs.active.path,
    open: new Set(paths.map((tab) => tab.path)),
    dirty: new Set(paths.filter((tab) => dirty(tab)).map((tab) => tab.path)),
  });
  // Show where the current file is, once per file.
  if (tabs.active.path !== revealed) {
    revealed = tabs.active.path;
    fileTree.reveal(revealed).catch(report);
  }
}
async function setWorkspace(workspace) {
  $('workspace-name').textContent = workspace?.name ?? '';
  $('workspace-name').title = workspace?.path ?? '';
  $('files-empty').hidden = Boolean(workspace);
  $('file-tree').hidden = !workspace;
  $('refresh-files').hidden = !workspace;
  $('files-actions').hidden = !workspace;
  $('close-folder').disabled = !workspace;
  revealed = null;
  await fileTree.setRoot(workspace);
  markFiles();
}
// Files or Outline, remembered on this device.
function showSidebar(view, { focus = false } = {}) {
  for (const [name, tab, panel, item] of [['files', 'sidebar-files', 'files-panel', 'view-files'], ['outline', 'sidebar-outline', 'outline-panel', 'view-outline']]) {
    const shown = name === view;
    $(tab).setAttribute('aria-selected', String(shown));
    $(tab).tabIndex = shown ? 0 : -1;
    $(panel).hidden = !shown;
    setPressed($(item), shown);
  }
  try { storage?.setItem('textgate.sidebar', view); } catch { /* keep it for this session */ }
  if (focus) focusSidebar();
}
const sidebarView = () => ($('sidebar-files').getAttribute('aria-selected') === 'true' ? 'files' : 'outline');
function focusSidebar() {
  if (sidebarView() === 'outline') ($('outline').querySelector('button') ?? $('outline')).focus();
  else if (fileTree.root) fileTree.focus();
  else $('open-folder-here').focus();
}
async function openFolder() {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open a folder.'; return; }
  const selected = await open({ directory: true });
  if (!selected) return;
  await setWorkspace(await invoke('open_workspace', { path: selected }));
  showSidebar('files', { focus: true });
  if ($('toggle-outline').getAttribute('aria-pressed') !== 'true') $('toggle-outline').click();
  $('status').textContent = `Opened folder ${fileTree.root.name}`;
}
$('open-folder').onclick = () => run(openFolder);
$('open-folder-here').onclick = () => run(openFolder);
$('close-folder').onclick = () => run(async () => {
  await invoke('close_workspace');
  await setWorkspace(null);
  $('status').textContent = 'Folder closed. Open tabs stay open.';
});
$('refresh-files').onclick = () => fileTree.refresh().catch(report);
$('new-file-here').onclick = () => run(() => newEntry('file'));
$('new-folder-here').onclick = () => run(() => newEntry('folder'));
$('view-files').onclick = () => showSidebar('files', { focus: true });
$('view-outline').onclick = () => showSidebar('outline', { focus: true });
$('sidebar-files').onclick = () => showSidebar('files');
$('sidebar-outline').onclick = () => showSidebar('outline');
document.querySelector('.sidebar-switch').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  showSidebar(sidebarView() === 'files' ? 'outline' : 'files');
  $(sidebarView() === 'files' ? 'sidebar-files' : 'sidebar-outline').focus();
});
// Without file watching (0.1.7), catch outside changes when returning to the window.
window.addEventListener('focus', () => { fileTree.refresh().catch(report); });
async function tabWithDocument(id) {
  for (const tab of tabs.list) if (await tab.file.id() === id) return tab;
  return null;
}
const vimExtensions = () => [vim(), fullHeightVimCursor];
function extensions(initialFormat = defaultFormat) {
  return [vimMode.of(vimEnabled ? vimExtensions() : []), basicSetup, preserveDocumentFormat(initialFormat), numbersMode.of(relativeNumbers ? relativeLineNumbers() : []),
    spellcheckMode.of(spellchecking ? spellcheck() : []),
    // classHighlighter has no class for strikethrough.
    syntaxHighlighting(classHighlighter), syntaxHighlighting(tagHighlighter([{ tag: tags.strikethrough, class: 'tok-strikethrough' }])),
    markdown({ base: markdownLanguage, codeLanguages: fencedLanguage }),
    liveMode.of(mode === 'live' ? livePreview({ render }) : []),
    keymap.of([indentWithTab,
      { key: 'Mod-b', run: (target) => { format.toggleInline(target, 'bold'); return true; } },
      { key: 'Mod-i', run: (target) => { format.toggleInline(target, 'italic'); return true; } },
      { key: 'Mod-Shift-x', run: (target) => format.toggleTask(target) }]),
    textDirection(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown document' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) documentChanged();
      else if (update.startState.field(documentFormat) !== update.state.field(documentFormat)) refresh();
      if (update.docChanged || update.selectionSet) updateToolbar();
    })];
}
const run = createActionRunner({
  onBusy: () => { $('status').textContent = 'A file operation is still in progress. Finish or cancel it, then try again.'; },
  onError: report,
  onQueued: () => { $('status').textContent = 'File open request queued until the current operation finishes.'; },
});
const openPath = createDocumentOpener({
  documents, existing: (path) => tabs.withPath(path), holder: tabWithDocument, show: showTab, place,
});
async function openFile(path, options) {
  const { tab, format: opened, already } = await openPath(path, options);
  const label = fileName(tab.path);
  $('status').textContent = already ? `${label} is already open`
    : opened.mixed ? `Opened ${label}. It mixes line endings; existing line endings will be preserved.`
    : `Opened ${label}`;
}
async function openDocument() {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return; }
  const selected = await open({ multiple: true, filters });
  for (const path of [selected ?? []].flat()) await openFile(path);
}
// Resolves true only when the document was written.
async function saveDocument(saveAs = false, tab = tabs.active) {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return false; }
  // The tab is fixed now: a save that finishes after switching tabs updates
  // the tab it started from.
  const chosen = !tab.path || saveAs;
  const destination = chosen ? await save({ defaultPath: tab.path ?? 'Untitled.md', filters }) : tab.path;
  if (!destination) return false;
  const state = stateOf(tab);
  const snapshot = state.doc;
  const snapshotFormat = state.field(documentFormat);
  if (!await tab.file.save(destination, encodeDocument(snapshot.toString(), snapshotFormat), { chosen })) {
    $('status').textContent = 'Save cancelled. Your edits are still in the editor.';
    return false;
  }
  tab.path = destination;
  tab.deleted = false;
  tab.savedDoc = snapshot;
  tab.savedFormat = snapshotFormat;
  refresh();
  // Save As can create a file inside the open folder.
  if (chosen) fileTree.refresh().catch(report);
  $('status').textContent = `Saved ${fileName(destination)}`;
  return true;
}
$('new').onclick = () => {
  if (!(pristine(tabs.active) && !view.state.doc.length)) addTab();
  view.focus();
  $('status').textContent = 'New document';
};
$('close-tab').onclick = () => run(() => closeTab());
$('next-tab').onclick = () => showTab(tabs.step(1));
$('previous-tab').onclick = () => showTab(tabs.step(-1));
$('open').onclick = () => run(openDocument);
$('save').onclick = () => run(() => saveDocument());
$('save-as').onclick = () => run(() => saveDocument(true));
// The browser-only dev server leaves zoom to the browser itself.
const zoom = createZoom({
  setZoom: (level) => getCurrentWebview().setZoom(level),
  storage,
  onChange: (level) => { $('status').textContent = `Zoom ${Math.round(level * 100)}%`; },
});
for (const [id, action] of [['zoom-in', 'in'], ['zoom-out', 'out'], ['zoom-reset', 'reset']]) {
  $(id).onclick = () => {
    if (!isTauri()) { $('status').textContent = 'Use your browser\'s zoom in browser-only development.'; return; }
    zoom[action]().catch(report);
  };
}
if (isTauri()) zoom.restore().catch(report);
$('relative-numbers').onclick = () => {
  relativeNumbers = !relativeNumbers;
  view.dispatch({ effects: numbersMode.reconfigure(relativeNumbers ? relativeLineNumbers() : []) });
  $('relative-numbers').setAttribute('aria-pressed', String(relativeNumbers));
  view.focus();
};
$('spellcheck').setAttribute('aria-pressed', String(spellchecking));
$('spellcheck').onclick = () => {
  spellchecking = !spellchecking;
  storeSpellcheck(storage, spellchecking);
  view.dispatch({ effects: spellcheckMode.reconfigure(spellchecking ? spellcheck() : []) });
  $('spellcheck').setAttribute('aria-pressed', String(spellchecking));
  view.focus();
};
$('vim').onclick = () => {
  vimEnabled = !vimEnabled;
  view.dispatch({ effects: vimMode.reconfigure(vimEnabled ? vimExtensions() : []) });
  $('vim').setAttribute('aria-pressed', String(vimEnabled));
  updateEditorStatus();
  view.focus();
};
function updateEditorStatus() {
  const cm = getCM(view);
  const state = cm?.state.vim;
  const label = mode === 'live' ? 'Live' : 'Source';
  // The cursor no longer shrinks in Replace mode, so name that mode here.
  const vimLabel = cm?.state.overwrite ? 'REPLACE' : state?.insertMode ? 'INSERT' : state?.visualMode ? 'VISUAL' : 'NORMAL';
  $('editor-status').textContent = !vimEnabled ? label : `${label} · Vim ${vimLabel}`;
}
// Vim mode changes may not modify the document, so update after key handling too.
view.dom.addEventListener('keydown', () => queueMicrotask(updateEditorStatus));
$('quit').onclick = () => run(async () => {
  if (!isTauri()) { $('status').textContent = 'Close this browser tab to quit.'; return; }
  if (await approveQuit()) await getCurrentWindow().destroy();
});
defineVimFileCommands(Vim, {
  run,
  save: () => saveDocument(),
  saveAs: () => saveDocument(true),
  isDirty: () => dirty(),
  // Callers have already saved or chosen to discard, so close the tab without
  // asking; closing the last one closes the window.
  close: async () => {
    if (tabs.size > 1) { discardTab(tabs.active); return; }
    if (!isTauri()) { $('status').textContent = 'Close this browser tab to quit.'; return; }
    await getCurrentWindow().destroy();
  },
  message: (text) => { $('status').textContent = text; },
  // Vim is still handling the key when these run; switch tabs once it is done.
  tabs: {
    step: (offset) => setTimeout(() => showTab(tabs.step(offset))),
    go: (position) => setTimeout(() => showTab(tabs.list[position - 1] ?? tabs.list.at(-1))),
    add: () => setTimeout(() => $('new').click()),
    anyDirty: () => tabs.list.some((tab) => dirty(tab)),
    // Callers have checked or chosen to discard unsaved changes.
    closeAll: async () => {
      if (!isTauri()) { $('status').textContent = 'Close this browser tab to quit.'; return; }
      await getCurrentWindow().destroy();
    },
  },
});
$('edit-undo').onclick = () => { undo(view); view.focus(); };
$('edit-redo').onclick = () => { redo(view); view.focus(); };
$('normalize-endings').onclick = () => {
  $('line-ending-style').value = { '\n': 'lf', '\r\n': 'crlf', '\r': 'cr' }[view.state.field(documentFormat).lineEnding];
  $('line-endings-dialog').showModal();
};
$('apply-line-endings').onclick = () => {
  const ending = { lf: '\n', crlf: '\r\n', cr: '\r' }[$('line-ending-style').value];
  const changed = normalizeLineEndings(view, ending);
  $('line-endings-dialog').close();
  $('status').textContent = changed
    ? `Line endings normalized to ${lineEndingLabel(view.state.field(documentFormat))}. Save to write the change; Undo restores the previous endings.`
    : 'Line endings already match. No changes made.';
  view.focus();
};
for (const id of ['find', 'replace']) $(id).onclick = () => {
  view.focus();
  openSearchPanel(view);
  view.dom.querySelector(id === 'replace' ? '[name="replace"]' : '[name="search"]')?.focus();
};
for (const part of ['preview', 'outline']) {
  $(`toggle-${part}`).onclick = () => {
    const button = $(`toggle-${part}`);
    const show = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(show));
    document.querySelector('main').classList.toggle(`hide-${part}`, !show);
    view.requestMeasure();
    refreshPreview();
  };
}
$('refresh-preview').onclick = () => refreshPreview(true);
$('view-live').onclick = () => $('mode-live').click();
$('view-source').onclick = () => $('mode-source').click();
$('shortcuts').onclick = () => $('shortcuts-dialog').showModal();
$('about').onclick = () => $('about-dialog').showModal();
$('app-version').textContent = packageInfo.version;
// F6 and Shift+F6 move focus between the visible panes, as in browsers and
// many editors, so keyboard users need not Tab through every toolbar button.
function cyclePanes(backwards) {
  const main = document.querySelector('main');
  const panes = [
    [$('tabbar'), () => $(`tab-${tabs.active.id}`)?.focus()],
    !main.classList.contains('hide-outline') && [document.querySelector('main > aside'), focusSidebar],
    [$('editor'), () => view.focus()],
    previewVisible() && [$('preview'), () => $('preview').focus()],
  ].filter(Boolean);
  const current = panes.findIndex(([pane]) => pane.contains(document.activeElement));
  const next = current === -1 ? (backwards ? panes.length - 1 : 0) : (current + (backwards ? panes.length - 1 : 1)) % panes.length;
  panes[next][1]();
}
window.addEventListener('keydown', (event) => {
  if (appDialogOpen(document)) return;
  if (event.key === 'F6' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    cyclePanes(event.shiftKey);
    return;
  }
  const switchTo = tabShortcut(event);
  if (switchTo) {
    event.preventDefault();
    event.stopPropagation();
    showTab(switchTo, { focus: !$('tabbar').contains(document.activeElement) });
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  // Many layouts need Shift for +, which the Ctrl/Cmd+= menu shortcut misses.
  if (key === '+' && isTauri()) { event.preventDefault(); $('zoom-in').click(); return; }
  if (nativeMenus) return;
  if (isTauri() && ['=', '-', '0'].includes(key)) {
    event.preventDefault();
    $({ '=': 'zoom-in', '-': 'zoom-out', 0: 'zoom-reset' }[key]).click();
    return;
  }
  if (!['n', 'o', 's', 'q', 'w'].includes(key)) return;
  event.preventDefault();
  if (key === 'w') $('close-tab').click();
  if (key === 'n') $('new').click();
  if (key === 'o') $('open').click();
  if (key === 's') run(() => saveDocument(event.shiftKey));
  if (key === 'q') $('quit').click();
}, true);
// Preview links must not navigate away from the editor; in-page anchors scroll.
// Sanitizing prefixes document ids with user-content-, as GitHub does.
$('preview').addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  let fragment = href.slice(1);
  try { fragment = decodeURIComponent(fragment); } catch { /* malformed escape: use it as written */ }
  const target = href.startsWith('#') && [...$('preview').querySelectorAll('[id]')].find((element) => element.id === `user-content-${fragment}`);
  if (target) target.scrollIntoView({ block: 'start' });
  else $('status').textContent = `Link: ${href}`;
});
window.addEventListener('beforeunload', (event) => { if (tabs.list.some((tab) => dirty(tab))) { event.preventDefault(); event.returnValue = ''; } });
if (isTauri()) {
  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    await run(async () => { if (await approveQuit()) await getCurrentWindow().destroy(); });
  }).catch(report);
}
function setMode(next) {
  previewVersion++;
  mode = next;
  view.dispatch({ effects: liveMode.reconfigure(mode === 'live' ? livePreview({ render }) : []) });
  document.querySelector('main').dataset.mode = mode;
  for (const [id, value] of [['mode-live', 'live'], ['mode-source', 'source'], ['view-live', 'live'], ['view-source', 'source']]) {
    $(id).setAttribute('aria-pressed', String(mode === value));
  }
  $('toggle-preview').disabled = mode === 'live';
  $('mode-hint').textContent = mode === 'live' ? 'Markdown styled as you write' : 'Markdown source · preview';
  refresh();
  refreshPreview();
}
const commands = {
  bold: () => format.toggleInline(view, 'bold'), italic: () => format.toggleInline(view, 'italic'),
  strike: () => format.toggleInline(view, 'strike'), code: () => format.toggleInline(view, 'code'),
  bulletList: () => format.toggleList(view, 'bullet'), orderedList: () => format.toggleList(view, 'ordered'),
  taskList: () => format.toggleList(view, 'task'), blockquote: () => format.toggleQuote(view),
  codeBlock: () => format.toggleCodeBlock(view), table: () => format.insertTable(view),
  undo: () => undo(view), redo: () => redo(view),
};
function updateToolbar() {
  const { active, heading } = format.activeFormats(view.state);
  for (const button of document.querySelectorAll('[data-command]')) {
    const command = button.dataset.command;
    if (command === 'undo') button.disabled = !undoDepth(view.state);
    else if (command === 'redo') button.disabled = !redoDepth(view.state);
    else if (command !== 'table') setPressed(button, active.has(command));
  }
  $('block-type').value = heading ? String(heading) : 'paragraph';
  setPressed($('edit-link'), active.has('link'));
}
// Only touch attributes that change: native menus observe these mutations.
function setPressed(element, pressed) {
  if (element.getAttribute('aria-pressed') !== String(pressed)) element.setAttribute('aria-pressed', String(pressed));
}
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.onclick = () => { commands[button.dataset.command](); view.focus(); };
}
$('block-type').onchange = (event) => {
  format.setHeading(view, event.target.value === 'paragraph' ? 0 : Number(event.target.value));
  view.focus();
};
$('mode-live').onclick = () => { setMode('live'); view.focus(); };
$('mode-source').onclick = () => { setMode('source'); view.focus(); };
$('edit-link').onclick = () => {
  $('link-url').value = format.linkAt(view.state)?.href ?? '';
  $('link-error').textContent = '';
  $('link-dialog').showModal();
  $('link-url').focus();
};
$('link-cancel').onclick = () => $('link-dialog').close();
$('link-remove').onclick = () => {
  format.removeLink(view);
  $('link-dialog').close();
  view.focus();
};
$('link-form').onsubmit = (event) => {
  event.preventDefault();
  const href = $('link-url').value.trim();
  if (!href || /^\s*(javascript|vbscript|data):/i.test(href)) {
    $('link-error').textContent = 'Enter a web address, mailto: link, #anchor, or relative path.';
    return;
  }
  if (!format.applyLink(view, href)) {
    $('link-error').textContent = 'This is a reference link; edit its definition in the document.';
    return;
  }
  $('link-dialog').close();
  view.focus();
};
setMode('live');
updateToolbar();

setupExternalOpen({ desktop: isTauri(), listen, invoke, run, report,
  openPath: openFile,
}).catch(report);
// The folder from the last session, and the sidebar view last chosen.
const storedSidebar = (() => { try { return storage?.getItem('textgate.sidebar'); } catch { return null; } })();
if (isTauri()) {
  invoke('workspace').then(async (workspace) => {
    await setWorkspace(workspace);
    showSidebar(storedSidebar ?? (workspace ? 'files' : 'outline'));
  }).catch(report);
} else {
  $('files-empty').firstChild.textContent = 'Run the desktop app to browse folders.';
  showSidebar(storedSidebar === 'files' ? 'files' : 'outline');
}
setupThemes({ document, desktop: isTauri(), invoke });
setupMenus({ document, desktop: isTauri(), onError: report }).then((menus) => { nativeMenus = menus; }).catch(report);

export { refreshDetails as flushDetails };
