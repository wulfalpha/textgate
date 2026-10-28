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
import { vim, getCM } from '@replit/codemirror-vim';
import createDOMPurify from 'dompurify';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save, confirm } from '@tauri-apps/plugin-dialog';
import { createDocumentStore } from './document-store.js';
import { createActionRunner } from './action-runner.js';
import { decodeDocument, encodeDocument, defaultFormat, lineEndingLabel } from './document-format.js';
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

const $ = (id) => document.getElementById(id);
const initial = '# Welcome to Textgate\n\nA quiet place to write Markdown.\n\n## Start writing\n\nOpen a document or create a new one. Your preview updates as you type.\n\n- **Bold**, *italic*, and ~~strikethrough~~\n- Keyboard-friendly editing\n- Optional Vim keybindings\n- [x] Your Markdown is never rewritten\n\n## Tables\n\n| Feature | Status |\n| --- | --- |\n| Live preview | Ready |\n| GFM tables | Ready |\n\n```rust\nfn main() {\n    println!("Hello, Textgate!");\n}\n```\n';
let path = null;
let fileFormat = defaultFormat;
let savedDoc;
let vimEnabled = false;
let relativeNumbers = false;
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
const liveMode = new Compartment();
const filters = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const view = new EditorView({
  parent: $('editor'),
  state: EditorState.create({ doc: initial, extensions: extensions() }),
});
savedDoc = view.state.doc;
const dirty = () => !view.state.doc.eq(savedDoc);
const name = () => path?.split(/[\\/]/).pop() ?? 'Untitled.md';
const previewVisible = () => mode === 'source' && $('toggle-preview').getAttribute('aria-pressed') === 'true';

function refresh() {
  updateEditorStatus();
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
      $('stats').textContent = `${result.words} words · ${doc.lines} lines · ${lineEndingLabel(fileFormat)}`;
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
async function canDiscard() {
  return !dirty() || (isTauri()
    ? await confirm('Discard unsaved changes?', { title: 'Textgate', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Keep editing' })
    : window.confirm('Discard unsaved changes?'));
}
function replaceDocument(text, nextPath, nextFormat = defaultFormat) {
  path = nextPath;
  fileFormat = nextFormat;
  // New state intentionally clears undo history between documents.
  view.setState(EditorState.create({ doc: text, extensions: extensions() }));
  savedDoc = view.state.doc;
  previewRenderedDoc = null;
  $('preview').replaceChildren();
  delete $('outline').dataset.outlineLimit;
  documentChanged();
  updateToolbar();
  view.focus();
}
function extensions() {
  return [vimMode.of(vimEnabled ? vim() : []), basicSetup, numbersMode.of(relativeNumbers ? relativeLineNumbers() : []),
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
      if (update.docChanged || update.selectionSet) updateToolbar();
    })];
}
const run = createActionRunner({
  onBusy: () => { $('status').textContent = 'A file operation is still in progress. Finish or cancel it, then try again.'; },
  onError: report,
});
async function openDocument() {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return; }
  const beforeOpen = view.state.doc;
  if (!await canDiscard()) return;
  const selected = await open({ multiple: false, filters });
  if (!selected) return;
  const bytes = await documents.read(selected);
  const { text, format: opened } = decodeDocument(bytes);
  // Editing can continue while the dialog is open; recheck before replacing it.
  if (!view.state.doc.eq(beforeOpen) && !await canDiscard()) return;
  await documents.remember(selected);
  replaceDocument(text, selected, opened);
  $('status').textContent = opened.mixed
    ? `Opened ${name()}. It mixes line endings; saving will use ${lineEndingLabel(opened)} throughout.`
    : `Opened ${name()}`;
}
async function saveDocument(saveAs = false) {
  if (!isTauri()) { $('status').textContent = 'Run npm run tauri dev to open and save local files.'; return; }
  const chosen = !path || saveAs;
  const destination = chosen ? await save({ defaultPath: path ?? 'Untitled.md', filters }) : path;
  if (!destination) return;
  const snapshot = view.state.doc;
  if (!await documents.save(destination, encodeDocument(snapshot.toString(), fileFormat), { chosen })) {
    $('status').textContent = 'Save cancelled. Your edits are still in the editor.';
    return;
  }
  path = destination;
  savedDoc = snapshot;
  refresh();
  $('status').textContent = `Saved ${name()}`;
}
$('new').onclick = () => run(async () => { if (await canDiscard()) { replaceDocument('', null); $('status').textContent = 'New document'; } });
$('open').onclick = () => run(openDocument);
$('save').onclick = () => run(() => saveDocument());
$('save-as').onclick = () => run(() => saveDocument(true));
// The browser-only dev server leaves zoom to the browser itself.
const zoom = createZoom({
  setZoom: (level) => getCurrentWebview().setZoom(level),
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
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
$('vim').onclick = () => {
  vimEnabled = !vimEnabled;
  view.dispatch({ effects: vimMode.reconfigure(vimEnabled ? vim() : []) });
  $('vim').setAttribute('aria-pressed', String(vimEnabled));
  updateEditorStatus();
  view.focus();
};
function updateEditorStatus() {
  const state = getCM(view)?.state.vim;
  const label = mode === 'live' ? 'Live' : 'Source';
  $('editor-status').textContent = !vimEnabled ? label
    : `${label} · Vim ${state?.insertMode ? 'INSERT' : state?.visualMode ? 'VISUAL' : 'NORMAL'}`;
}
// Vim mode changes may not modify the document, so update after key handling too.
view.dom.addEventListener('keydown', () => queueMicrotask(updateEditorStatus));
$('quit').onclick = () => run(async () => {
  if (!isTauri()) { $('status').textContent = 'Close this browser tab to quit.'; return; }
  if (await canDiscard()) await getCurrentWindow().destroy();
});
$('edit-undo').onclick = () => { undo(view); view.focus(); };
$('edit-redo').onclick = () => { redo(view); view.focus(); };
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
window.addEventListener('keydown', (event) => {
  if (appDialogOpen(document)) return;
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
  if (!['n', 'o', 's', 'q'].includes(key)) return;
  event.preventDefault();
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
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
if (isTauri()) {
  getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    await run(async () => { if (await canDiscard()) await getCurrentWindow().destroy(); });
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

setupThemes({ document, desktop: isTauri(), invoke });
setupMenus({ document, desktop: isTauri(), onError: report }).then((menus) => { nativeMenus = menus; }).catch(report);

export { refreshDetails as flushDetails };
